import { Database } from "bun:sqlite";
import {
  IS_HOSTED,
  LEGENDUM_API_KEY,
  LEGENDUM_SECRET,
  LEGENDUM_BASE_URL,
  FREE_SOURCE_PUSHES,
  FREE_WIKI_UPDATES,
  FREE_WIKIS,
  COST_SOURCE_PUSH,
  COST_WIKI_UPDATE,
  COST_WIKI_STORAGE,
} from "./constants";

type EventType = "source_push" | "wiki_update" | "storage";

/**
 * Record a billing event.
 */
export function recordEvent(
  db: Database,
  wikiId: number | null,
  type: EventType,
  count = 1
): void {
  db.prepare("INSERT INTO events (wiki_id, type, count) VALUES (?, ?, ?)").run(
    wikiId,
    type,
    count
  );
}

/**
 * Get usage for the current month.
 */
export function getMonthlyUsage(
  db: Database
): Record<EventType, number> {
  const period = new Date();
  period.setDate(1);
  const periodStart = period.toISOString().slice(0, 10);

  const rows = db
    .prepare(
      "SELECT type, SUM(count) as total FROM events WHERE created_at >= ? GROUP BY type"
    )
    .all(periodStart) as { type: EventType; total: number }[];

  const usage: Record<string, number> = {
    source_push: 0,
    wiki_update: 0,
    storage: 0,
  };
  for (const row of rows) usage[row.type] = row.total;
  return usage as Record<EventType, number>;
}

/**
 * Check if the user is within free quota for an action.
 */
export function isWithinFreeQuota(
  db: Database,
  type: EventType
): boolean {
  if (!IS_HOSTED) return true; // self-hosted: no billing

  const usage = getMonthlyUsage(db);

  switch (type) {
    case "source_push":
      return usage.source_push < FREE_SOURCE_PUSHES;
    case "wiki_update":
      return usage.wiki_update < FREE_WIKI_UPDATES;
    case "storage": {
      const wikiCount = (
        db.prepare("SELECT COUNT(*) as count FROM wikis").get() as {
          count: number;
        }
      ).count;
      return wikiCount <= FREE_WIKIS;
    }
  }
}

/**
 * Charge Legendum credits for an action. Returns true if successful.
 * Skipped in self-hosted mode.
 */
export async function charge(
  legendumToken: string | null,
  type: EventType,
  description: string
): Promise<{ ok: boolean; error?: string }> {
  if (!IS_HOSTED) return { ok: true };
  if (!legendumToken) return { ok: false, error: "no_legendum_token" };

  const amount =
    type === "source_push"
      ? COST_SOURCE_PUSH
      : type === "wiki_update"
        ? COST_WIKI_UPDATE
        : COST_WIKI_STORAGE;

  try {
    const res = await fetch(`${LEGENDUM_BASE_URL}/api/charge`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${LEGENDUM_SECRET}`,
        "X-API-Key": LEGENDUM_API_KEY!,
      },
      body: JSON.stringify({
        token: legendumToken,
        amount,
        description,
      }),
    });

    const data = (await res.json()) as { ok: boolean; error?: string };
    return data;
  } catch {
    return { ok: false, error: "legendum_unreachable" };
  }
}
