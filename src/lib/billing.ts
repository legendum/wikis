/**
 * Billing — reserve/settle/charge via Legendum credits.
 *
 * Charges only apply when:
 * 1. Running in hosted mode (LEGENDUM_API_KEY + LEGENDUM_SECRET set)
 * 2. User does NOT have their own LLM API key (self-hosted users pay their provider directly)
 *
 * Flow: reserve → LLM call → settle (actual tokens) → charge shortfall if needed
 */

import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import yaml from "js-yaml";
import { resolveProvider } from "./ai";
import { CONFIG_DIR } from "./constants";
import type { LegendumReservation } from "./legendum.js";
import { log } from "./log";
import { isByLegendum } from "./mode";

// --- Pricing config ---

interface ModelPricing {
  label: string;
  model: string;
  input_credits_per_million: number;
  output_credits_per_million: number;
  markup_percent: number;
  minimum_charge?: number;
}

const pricingPath = resolve(CONFIG_DIR, "pricing.yml");
const pricingConfig = yaml.load(readFileSync(pricingPath, "utf8")) as {
  models: Record<string, ModelPricing>;
};

export function getModelPricing(provider?: string): ModelPricing {
  const p = resolveProvider(provider);
  const cfg = pricingConfig.models[p];
  if (!cfg) throw new Error(`No pricing config for provider: ${p}`);
  return cfg;
}

// --- Credit calculation ---

export function calculateCredits(
  inputTokens: number,
  outputTokens: number,
  provider?: string,
): number {
  const cfg = getModelPricing(provider);
  const inputCredits =
    (inputTokens / 1_000_000) * cfg.input_credits_per_million;
  const outputCredits =
    (outputTokens / 1_000_000) * cfg.output_credits_per_million;
  const markup = 1 + (cfg.markup_percent || 0) / 100;
  return Math.max(
    cfg.minimum_charge || 1,
    Math.ceil((inputCredits + outputCredits) * markup),
  );
}

/** Estimate upfront reserve amount (small hold before LLM call). */
export function reserveAmount(provider?: string): number {
  const cfg = getModelPricing(provider);
  return Math.max(1, Math.ceil(cfg.input_credits_per_million / 20));
}

// --- Legendum integration ---

type LegendumModule = typeof import("./legendum.js").default;
let legendum: LegendumModule | null = null;
async function getLegendum(): Promise<LegendumModule> {
  if (!legendum) {
    const mod = await import("./legendum.js");
    legendum = mod.default || mod;
  }
  return legendum;
}

/** Should we bill this user? Only in hosted mode when user has no own API key. */
export function shouldBill(userHasOwnKey: boolean): boolean {
  return isByLegendum() && !userHasOwnKey;
}

export interface Reservation {
  id: string;
  amount: number;
  settle: LegendumReservation["settle"];
  release: LegendumReservation["release"];
}

/**
 * Reserve credits before an LLM call.
 * Returns null if billing is not applicable.
 * Throws if insufficient funds.
 */
export async function reserve(
  legendumToken: string | null,
  amount: number,
  description: string,
): Promise<Reservation | null> {
  if (!legendumToken) return null;

  const leg = await getLegendum();

  log.info(`Reserving ${amount} credits`, { description });

  const reservation = await leg.reserve(legendumToken, amount, description);
  return reservation;
}

/**
 * Settle a reservation with actual token usage.
 * Charges shortfall if actual > reserved.
 */
export async function settle(
  reservation: Reservation | null,
  legendumToken: string | null,
  inputTokens: number,
  outputTokens: number,
  description: string,
  event?: { db: Database; wikiId: number },
): Promise<number> {
  const totalCredits = calculateCredits(inputTokens, outputTokens);

  // Record credits used regardless of billing
  if (event) {
    recordEvent(
      event.db,
      event.wikiId,
      "credits_used",
      totalCredits,
      description,
    );
  }

  if (!reservation || !legendumToken) return totalCredits;

  const leg = await getLegendum();

  // Settle up to reserved amount
  const settleAmount = Math.min(totalCredits, reservation.amount);
  try {
    await reservation.settle(settleAmount);
    log.info(`Settled ${settleAmount} credits (of ${totalCredits} total)`);
  } catch (e) {
    log.error("Failed to settle reservation", { error: (e as Error).message });
  }

  // Charge shortfall if actual cost exceeded reservation
  const shortfall = totalCredits - settleAmount;
  if (shortfall > 0) {
    try {
      await leg.charge(legendumToken, shortfall, description);
      log.info(`Charged ${shortfall} credits shortfall`);
    } catch {
      // Try to take whatever balance remains
      try {
        const bal = await leg.balance(legendumToken);
        const take = Math.min(Math.floor(bal.balance), shortfall);
        if (take > 0) {
          await leg.charge(legendumToken, take, description);
          log.info(`Charged ${take} credits (partial shortfall)`);
        }
      } catch {
        // ignore — best effort
      }
    }
  }

  return totalCredits;
}

/**
 * Release a reservation without charging (e.g. on error).
 */
export async function release(reservation: Reservation | null): Promise<void> {
  if (!reservation) return;
  try {
    await reservation.release();
    log.info("Released reservation");
  } catch (e) {
    log.error("Failed to release reservation", { error: (e as Error).message });
  }
}

// --- Event logging (for usage tracking) ---

type EventType = "source_push" | "wiki_update" | "credits_used" | "storage";

export function recordEvent(
  db: Database,
  wikiId: number | null,
  type: EventType,
  count = 1,
  description = "",
): void {
  db.prepare(
    "INSERT INTO events (wiki_id, type, count, description) VALUES (?, ?, ?, ?)",
  ).run(wikiId, type, count, description);
}

export function getMonthlyUsage(db: Database): Record<EventType, number> {
  const period = new Date();
  period.setDate(1);
  const periodStart = period.toISOString().slice(0, 10);

  const rows = db
    .prepare(
      "SELECT type, SUM(count) as total FROM events WHERE created_at >= ? GROUP BY type",
    )
    .all(periodStart) as { type: EventType; total: number }[];

  const usage: Record<string, number> = {
    source_push: 0,
    wiki_update: 0,
    credits_used: 0,
    storage: 0,
  };
  for (const row of rows) usage[row.type] = row.total;
  return usage as Record<EventType, number>;
}
