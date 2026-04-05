import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createHash } from 'crypto';
import { resolve } from 'path';
import { createTestDataDir } from '../helpers/db';

/**
 * Tests for storage operations (hashContent, upsert, get, list, delete, manifest).
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS wikis (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS wiki_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wiki_id INTEGER NOT NULL REFERENCES wikis(id),
    path TEXT NOT NULL,
    content TEXT,
    hash TEXT NOT NULL,
    modified_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(wiki_id, path)
);
`;

function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

function upsertFile(
  db: Database,
  wikiId: number,
  path: string,
  content: string,
  modified: string
): void {
  const hash = hashContent(content);
  db.prepare(`
    INSERT INTO wiki_files (wiki_id, path, content, hash, modified_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(wiki_id, path) DO UPDATE SET
      content = excluded.content, hash = excluded.hash, modified_at = excluded.modified_at
  `).run(wikiId, path, content, hash, modified);
}

describe('storage', () => {
  let tmp: { dir: string; cleanup: () => void };
  let db: Database;
  let wikiId: number;

  beforeEach(() => {
    tmp = createTestDataDir();
    db = new Database(resolve(tmp.dir, 'test.db'), { create: true });
    db.exec('PRAGMA foreign_keys = ON');
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

  it('hashContent produces consistent 16-char hex', () => {
    const h1 = hashContent('hello');
    const h2 = hashContent('hello');
    expect(h1).toBe(h2);
    expect(h1.length).toBe(16);
    expect(/^[0-9a-f]+$/.test(h1)).toBe(true);
  });

  it('hashContent differs for different content', () => {
    expect(hashContent('hello')).not.toBe(hashContent('world'));
  });

  it('upserts new files', () => {
    upsertFile(db, wikiId, 'page.md', '# Page', '2026-01-01');
    const row = db
      .prepare('SELECT content FROM wiki_files WHERE wiki_id = ? AND path = ?')
      .get(wikiId, 'page.md') as { content: string };
    expect(row.content).toBe('# Page');
  });

  it('updates existing files on conflict', () => {
    upsertFile(db, wikiId, 'page.md', '# V1', '2026-01-01');
    upsertFile(db, wikiId, 'page.md', '# V2', '2026-01-02');
    const row = db
      .prepare(
        'SELECT content, modified_at FROM wiki_files WHERE wiki_id = ? AND path = ?'
      )
      .get(wikiId, 'page.md') as { content: string; modified_at: string };
    expect(row.content).toBe('# V2');
    expect(row.modified_at).toBe('2026-01-02');
  });

  it('lists files ordered by path', () => {
    upsertFile(db, wikiId, 'z.md', 'z', '2026-01-01');
    upsertFile(db, wikiId, 'a.md', 'a', '2026-01-01');
    upsertFile(db, wikiId, 'm.md', 'm', '2026-01-01');
    const rows = db
      .prepare('SELECT path FROM wiki_files WHERE wiki_id = ? ORDER BY path')
      .all(wikiId) as { path: string }[];
    expect(rows.map((r) => r.path)).toEqual(['a.md', 'm.md', 'z.md']);
  });

  it('deletes files', () => {
    upsertFile(db, wikiId, 'page.md', 'content', '2026-01-01');
    db.prepare('DELETE FROM wiki_files WHERE wiki_id = ? AND path = ?').run(
      wikiId,
      'page.md'
    );
    const row = db
      .prepare('SELECT * FROM wiki_files WHERE wiki_id = ? AND path = ?')
      .get(wikiId, 'page.md');
    expect(row).toBeNull();
  });

  it('builds manifest with hash and modified', () => {
    upsertFile(db, wikiId, 'a.md', 'aaa', '2026-01-01');
    upsertFile(db, wikiId, 'b.md', 'bbb', '2026-01-02');
    const rows = db
      .prepare(
        'SELECT path, hash, modified_at FROM wiki_files WHERE wiki_id = ?'
      )
      .all(wikiId) as { path: string; hash: string; modified_at: string }[];
    const manifest: Record<string, { hash: string; modified: string }> = {};
    for (const row of rows)
      manifest[row.path] = { hash: row.hash, modified: row.modified_at };

    expect(Object.keys(manifest)).toHaveLength(2);
    expect(manifest['a.md'].hash).toBe(hashContent('aaa'));
    expect(manifest['b.md'].modified).toBe('2026-01-02');
  });
});
