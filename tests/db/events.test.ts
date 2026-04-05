import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { resolve } from 'path';
import { createTestDataDir } from '../helpers/db';

/**
 * Tests for event recording and monthly usage aggregation.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS wikis (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL DEFAULT '',
    visibility TEXT NOT NULL DEFAULT 'private',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wiki_id INTEGER REFERENCES wikis(id),
    type TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

function recordEvent(
  db: Database,
  wikiId: number | null,
  type: string,
  count = 1
): void {
  db.prepare('INSERT INTO events (wiki_id, type, count) VALUES (?, ?, ?)').run(
    wikiId,
    type,
    count
  );
}

function getMonthlyUsage(db: Database): Record<string, number> {
  const period = new Date();
  period.setDate(1);
  const periodStart = period.toISOString().slice(0, 10);
  const rows = db
    .prepare(
      'SELECT type, SUM(count) as total FROM events WHERE created_at >= ? GROUP BY type'
    )
    .all(periodStart) as { type: string; total: number }[];
  const usage: Record<string, number> = {
    source_push: 0,
    wiki_update: 0,
    credits_used: 0,
    storage: 0,
  };
  for (const row of rows) usage[row.type] = row.total;
  return usage;
}

describe('events', () => {
  let tmp: { dir: string; cleanup: () => void };
  let db: Database;
  let wikiId: number;

  beforeEach(() => {
    tmp = createTestDataDir();
    db = new Database(resolve(tmp.dir, 'test.db'), { create: true });
    db.exec(SCHEMA);
    db.prepare('INSERT INTO wikis (name) VALUES (?)').run('test');
    wikiId = (
      db.prepare('SELECT id FROM wikis WHERE name = ?').get('test') as {
        id: number;
      }
    ).id;
  });

  afterEach(() => {
    db.close();
    tmp.cleanup();
  });

  it('records and aggregates events by type', () => {
    recordEvent(db, wikiId, 'source_push', 3);
    recordEvent(db, wikiId, 'source_push', 2);
    recordEvent(db, wikiId, 'wiki_update', 1);

    const usage = getMonthlyUsage(db);
    expect(usage.source_push).toBe(5);
    expect(usage.wiki_update).toBe(1);
    expect(usage.credits_used).toBe(0);
  });

  it('tracks credits_used', () => {
    recordEvent(db, wikiId, 'credits_used', 42);
    recordEvent(db, wikiId, 'credits_used', 8);

    const usage = getMonthlyUsage(db);
    expect(usage.credits_used).toBe(50);
  });

  it('returns zeros when no events exist', () => {
    const usage = getMonthlyUsage(db);
    expect(usage.source_push).toBe(0);
    expect(usage.wiki_update).toBe(0);
    expect(usage.credits_used).toBe(0);
    expect(usage.storage).toBe(0);
  });

  it('allows null wiki_id for global events', () => {
    recordEvent(db, null, 'storage', 100);
    const usage = getMonthlyUsage(db);
    expect(usage.storage).toBe(100);
  });
});
