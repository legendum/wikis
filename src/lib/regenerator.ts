/**
 * Wiki regeneration after source changes.
 *
 * While a wiki already has pages, we debounce (15 minutes with no further
 * changes) to avoid burning tokens on active editing. Until the first page
 * exists, we run as soon as possible (setTimeout(0)) so a new wiki doesn't wait.
 */
import type { Database } from 'bun:sqlite';
import { runAgent, type WikiConfig } from './agent';
import { log } from './log';

const DEBOUNCE_MS = 15 * 60 * 1000; // 15 minutes

/** Pending timers keyed by "dbPath:wikiId" */
const timers = new Map<string, ReturnType<typeof setTimeout>>();

/** Immediate runs only — skip if an undebounced agent is already running */
const inFlight = new Set<string>();

function keyFor(dbPath: string, wikiId: number): string {
  return `${dbPath}:${wikiId}`;
}

/**
 * Schedule regeneration. With debounce (default), resets a 15-minute timer.
 * Without debounce (empty wiki / first build), runs on the next tick; returns
 * false if that path is already busy.
 */
export function scheduleRegeneration(
  dbPath: string,
  db: Database,
  wikiId: number,
  config: WikiConfig,
  opts?: { debounce?: boolean; reason?: string }
): boolean {
  const debounce = opts?.debounce ?? true;
  const reason = opts?.reason ?? 'source files changed';
  const key = keyFor(dbPath, wikiId);

  if (!debounce && inFlight.has(key)) {
    log.info(
      `Regeneration already in progress for ${config.name}, skipping duplicate`,
      { wiki: config.name }
    );
    return false;
  }

  const existing = timers.get(key);
  if (existing) {
    clearTimeout(existing);
    if (debounce) {
      log.info(`Regeneration timer reset for ${config.name} (15 min)`, {
        wiki: config.name,
      });
    }
  } else if (debounce) {
    log.info(`Regeneration timer started for ${config.name} (15 min)`, {
      wiki: config.name,
    });
  } else {
    log.info(`Regeneration queued immediately for ${config.name}`, {
      wiki: config.name,
    });
  }

  const delay = debounce ? DEBOUNCE_MS : 0;

  const timer = setTimeout(async () => {
    timers.delete(key);
    if (!debounce) inFlight.add(key);
    log.info(
      debounce
        ? `Regeneration timer fired for ${config.name}`
        : `Regeneration started for ${config.name}`,
      {
        wiki: config.name,
      }
    );
    try {
      const result = await runAgent(db, wikiId, config, { reason });
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
    } finally {
      if (!debounce) inFlight.delete(key);
    }
  }, delay);

  timers.set(key, timer);
  return true;
}
