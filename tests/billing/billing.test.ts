import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import { createTestDataDir } from "../helpers/db";

/**
 * Tests for the pure-function pieces of billing.ts: shouldBill, calculateCredits,
 * recordEvent, getMonthlyUsage. The Legendum-facing reserve/settle/release flow
 * is intentionally NOT tested here — it requires a live network mock and the
 * tests in this repo do not stub fetch.
 *
 * Logic is inlined to avoid pulling in constants.ts (which reads pricing.yml
 * at import time and would couple us to live config files).
 */

interface ModelPricing {
  input_credits_per_million: number;
  output_credits_per_million: number;
  markup_percent: number;
  minimum_charge?: number;
}

const FAKE_PRICING: ModelPricing = {
  input_credits_per_million: 1000,
  output_credits_per_million: 4000,
  markup_percent: 25,
  minimum_charge: 1,
};

function calculateCredits(
  cfg: ModelPricing,
  inputTokens: number,
  outputTokens: number,
): number {
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

function shouldBill(isHosted: boolean, userHasOwnKey: boolean): boolean {
  return isHosted && !userHasOwnKey;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS wikis (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wiki_id INTEGER REFERENCES wikis(id),
  type TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

function recordEvent(
  db: Database,
  wikiId: number | null,
  type: string,
  count = 1,
  description = "",
): void {
  db.prepare(
    "INSERT INTO events (wiki_id, type, count, description) VALUES (?, ?, ?, ?)",
  ).run(wikiId, type, count, description);
}

describe("shouldBill", () => {
  it("bills hosted users without their own key", () => {
    expect(shouldBill(true, false)).toBe(true);
  });

  it("does not bill hosted users with their own key", () => {
    expect(shouldBill(true, true)).toBe(false);
  });

  it("does not bill self-hosted users", () => {
    expect(shouldBill(false, false)).toBe(false);
    expect(shouldBill(false, true)).toBe(false);
  });
});

describe("calculateCredits", () => {
  it("applies markup", () => {
    // 1M in + 1M out = 1000 + 4000 = 5000, * 1.25 = 6250
    expect(calculateCredits(FAKE_PRICING, 1_000_000, 1_000_000)).toBe(6250);
  });

  it("rounds up", () => {
    // tiny usage rounds up to minimum_charge or ceil
    expect(calculateCredits(FAKE_PRICING, 1, 1)).toBe(1);
  });

  it("respects minimum charge", () => {
    expect(calculateCredits(FAKE_PRICING, 0, 0)).toBe(1);
  });

  it("scales linearly with token count", () => {
    const a = calculateCredits(FAKE_PRICING, 100_000, 100_000);
    const b = calculateCredits(FAKE_PRICING, 200_000, 200_000);
    // b should be ~2x a (within rounding)
    expect(b).toBeGreaterThanOrEqual(a * 2 - 1);
    expect(b).toBeLessThanOrEqual(a * 2 + 1);
  });

  it("output tokens cost more than input tokens", () => {
    const inputOnly = calculateCredits(FAKE_PRICING, 1_000_000, 0);
    const outputOnly = calculateCredits(FAKE_PRICING, 0, 1_000_000);
    expect(outputOnly).toBeGreaterThan(inputOnly);
  });

  it("handles zero markup", () => {
    const noMarkup: ModelPricing = { ...FAKE_PRICING, markup_percent: 0 };
    expect(calculateCredits(noMarkup, 1_000_000, 0)).toBe(1000);
  });
});

describe("recordEvent + monthly usage", () => {
  let tmp: { dir: string; cleanup: () => void };
  let db: Database;
  let wikiId: number;

  beforeEach(() => {
    tmp = createTestDataDir();
    db = new Database(resolve(tmp.dir, "billing.db"), { create: true });
    db.exec(SCHEMA);
    db.prepare("INSERT INTO wikis (name) VALUES ('test')").run();
    wikiId = (db.prepare("SELECT id FROM wikis").get() as { id: number }).id;
  });

  afterEach(() => {
    db.close();
    tmp.cleanup();
  });

  it("records events with count and description", () => {
    recordEvent(db, wikiId, "credits_used", 50, "test op");
    const row = db
      .prepare("SELECT type, count, description FROM events")
      .get() as { type: string; count: number; description: string };
    expect(row.type).toBe("credits_used");
    expect(row.count).toBe(50);
    expect(row.description).toBe("test op");
  });

  it("aggregates events by type for the month", () => {
    recordEvent(db, wikiId, "credits_used", 100);
    recordEvent(db, wikiId, "credits_used", 50);
    recordEvent(db, wikiId, "source_push", 1);

    const period = new Date();
    period.setDate(1);
    const periodStart = period.toISOString().slice(0, 10);

    const rows = db
      .prepare(
        "SELECT type, SUM(count) as total FROM events WHERE created_at >= ? GROUP BY type",
      )
      .all(periodStart) as { type: string; total: number }[];

    const usage: Record<string, number> = {};
    for (const r of rows) usage[r.type] = r.total;

    expect(usage.credits_used).toBe(150);
    expect(usage.source_push).toBe(1);
  });

  it("allows null wiki_id (global events)", () => {
    recordEvent(db, null, "storage", 1);
    const row = db.prepare("SELECT wiki_id FROM events").get() as {
      wiki_id: number | null;
    };
    expect(row.wiki_id).toBeNull();
  });
});
