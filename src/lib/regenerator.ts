/**
 * Debounced wiki regeneration.
 *
 * When source files change, we don't regenerate immediately — we wait
 * 15 minutes of no further changes before asking the LLM to update
 * the wiki. This avoids wasting tokens on files being actively edited.
 */
import { Database } from "bun:sqlite";
import { runAgent, type WikiConfig } from "./agent";
import { log } from "./log";

const DEBOUNCE_MS = 15 * 60 * 1000; // 15 minutes

/** Pending timers keyed by "dbPath:wikiId" */
const timers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Schedule a wiki regeneration. Resets the timer if called again
 * before it fires (debounce).
 */
export function scheduleRegeneration(
  dbPath: string,
  db: Database,
  wikiId: number,
  config: WikiConfig,
): void {
  const key = `${dbPath}:${wikiId}`;

  const existing = timers.get(key);
  if (existing) {
    clearTimeout(existing);
    log.info(`Regeneration timer reset for ${config.name} (15 min)`, { wiki: config.name });
  } else {
    log.info(`Regeneration timer started for ${config.name} (15 min)`, { wiki: config.name });
  }

  const timer = setTimeout(async () => {
    timers.delete(key);
    log.info(`Regeneration timer fired for ${config.name}`, { wiki: config.name });
    try {
      const result = await runAgent(db, wikiId, config, { reason: "source files changed" });
      log.info(`Regeneration complete for ${config.name}`, {
        wiki: config.name,
        created: result.pagesCreated.length,
        updated: result.pagesUpdated.length,
        tokens: result.usage,
      });
    } catch (e) {
      log.error(`Regeneration failed for ${config.name}`, {
        wiki: config.name,
        error: (e as Error).message,
      });
    }
  }, DEBOUNCE_MS);

  timers.set(key, timer);
}

/** Check if a wiki has a pending regeneration timer. */
export function hasPendingRegeneration(dbPath: string, wikiId: number): boolean {
  return timers.has(`${dbPath}:${wikiId}`);
}
