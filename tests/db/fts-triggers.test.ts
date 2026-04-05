import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { resolve } from 'path';
import { createTestDataDir } from '../helpers/db';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS wikis (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    visibility TEXT NOT NULL DEFAULT 'private',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS wiki_chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wiki_id INTEGER NOT NULL REFERENCES wikis(id),
    path TEXT NOT NULL,
    chunk_index INTEGER NOT NULL,
    content TEXT NOT NULL,
    embedding BLOB,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(wiki_id, path, chunk_index)
);
CREATE VIRTUAL TABLE IF NOT EXISTS wiki_chunks_fts USING fts5(
    path, content, content=wiki_chunks, content_rowid=id, tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS wiki_chunks_ai AFTER INSERT ON wiki_chunks BEGIN
    INSERT INTO wiki_chunks_fts(rowid, path, content) VALUES (new.id, new.path, new.content);
END;
CREATE TRIGGER IF NOT EXISTS wiki_chunks_ad AFTER DELETE ON wiki_chunks BEGIN
    INSERT INTO wiki_chunks_fts(wiki_chunks_fts, rowid, path, content) VALUES ('delete', old.id, old.path, old.content);
END;
CREATE TRIGGER IF NOT EXISTS wiki_chunks_au AFTER UPDATE ON wiki_chunks BEGIN
    INSERT INTO wiki_chunks_fts(wiki_chunks_fts, rowid, path, content) VALUES ('delete', old.id, old.path, old.content);
    INSERT INTO wiki_chunks_fts(rowid, path, content) VALUES (new.id, new.path, new.content);
END;
`;

describe('FTS5 triggers', () => {
  let tmp: { dir: string; cleanup: () => void };
  let db: Database;
  let wikiId: number;

  beforeEach(() => {
    tmp = createTestDataDir();
    db = new Database(resolve(tmp.dir, 'fts-test.db'), { create: true });
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec(SCHEMA);

    db.prepare('INSERT INTO wikis (name) VALUES (?)').run('test');
    wikiId = (
      db.prepare("SELECT id FROM wikis WHERE name = 'test'").get() as {
        id: number;
      }
    ).id;
  });

  afterEach(() => {
    db.close();
    tmp.cleanup();
  });

  it('indexes wiki chunks on insert', () => {
    db.prepare(
      'INSERT INTO wiki_chunks (wiki_id, path, chunk_index, content) VALUES (?, ?, ?, ?)'
    ).run(
      wikiId,
      'architecture.md',
      0,
      'The system uses a manifest-based sync protocol'
    );

    const results = db
      .prepare('SELECT * FROM wiki_chunks_fts WHERE wiki_chunks_fts MATCH ?')
      .all('manifest') as { path: string }[];

    expect(results).toHaveLength(1);
    expect(results[0].path).toBe('architecture.md');
  });

  it('removes from FTS on delete', () => {
    db.prepare(
      'INSERT INTO wiki_chunks (wiki_id, path, chunk_index, content) VALUES (?, ?, ?, ?)'
    ).run(wikiId, 'architecture.md', 0, 'Elysia app setup');

    db.prepare('DELETE FROM wiki_chunks WHERE wiki_id = ? AND path = ?').run(
      wikiId,
      'architecture.md'
    );

    const results = db
      .prepare('SELECT * FROM wiki_chunks_fts WHERE wiki_chunks_fts MATCH ?')
      .all('elysia') as any[];

    expect(results).toHaveLength(0);
  });

  it('updates FTS on content update', () => {
    db.prepare(
      'INSERT INTO wiki_chunks (wiki_id, path, chunk_index, content) VALUES (?, ?, ?, ?)'
    ).run(wikiId, 'architecture.md', 0, 'Elysia app setup');

    db.prepare(
      'UPDATE wiki_chunks SET content = ? WHERE wiki_id = ? AND path = ?'
    ).run('Hono app setup with new framework', wikiId, 'architecture.md');

    const oldResults = db
      .prepare('SELECT * FROM wiki_chunks_fts WHERE wiki_chunks_fts MATCH ?')
      .all('elysia') as any[];
    expect(oldResults).toHaveLength(0);

    const newResults = db
      .prepare('SELECT * FROM wiki_chunks_fts WHERE wiki_chunks_fts MATCH ?')
      .all('hono') as any[];
    expect(newResults).toHaveLength(1);
  });

  it('supports porter stemming', () => {
    db.prepare(
      'INSERT INTO wiki_chunks (wiki_id, path, chunk_index, content) VALUES (?, ?, ?, ?)'
    ).run(
      wikiId,
      'sync.md',
      0,
      'syncing files between local and remote servers'
    );

    const results = db
      .prepare('SELECT * FROM wiki_chunks_fts WHERE wiki_chunks_fts MATCH ?')
      .all('sync') as any[];
    expect(results).toHaveLength(1);
  });

  it('supports boolean queries', () => {
    db.prepare(
      'INSERT INTO wiki_chunks (wiki_id, path, chunk_index, content) VALUES (?, ?, ?, ?)'
    ).run(wikiId, 'sync.md', 0, 'sync files to remote server');

    db.prepare(
      'INSERT INTO wiki_chunks (wiki_id, path, chunk_index, content) VALUES (?, ?, ?, ?)'
    ).run(wikiId, 'search.md', 0, 'search files in local database');

    const results = db
      .prepare('SELECT * FROM wiki_chunks_fts WHERE wiki_chunks_fts MATCH ?')
      .all('files NOT remote') as any[];

    expect(results).toHaveLength(1);
    expect(results[0].path).toBe('search.md');
  });

  it('supports BM25 ranking', () => {
    db.prepare(
      'INSERT INTO wiki_chunks (wiki_id, path, chunk_index, content) VALUES (?, ?, ?, ?)'
    ).run(wikiId, 'a.md', 0, 'sync sync sync sync sync');

    db.prepare(
      'INSERT INTO wiki_chunks (wiki_id, path, chunk_index, content) VALUES (?, ?, ?, ?)'
    ).run(wikiId, 'b.md', 0, 'sync once then done');

    const results = db
      .prepare(
        'SELECT path, rank FROM wiki_chunks_fts WHERE wiki_chunks_fts MATCH ? ORDER BY rank'
      )
      .all('sync') as { path: string; rank: number }[];

    expect(results).toHaveLength(2);
    expect(results[0].path).toBe('a.md');
  });

  it('supports prefix matching', () => {
    db.prepare(
      'INSERT INTO wiki_chunks (wiki_id, path, chunk_index, content) VALUES (?, ?, ?, ?)'
    ).run(wikiId, 'arch.md', 0, 'architecture of the system');

    const results = db
      .prepare('SELECT * FROM wiki_chunks_fts WHERE wiki_chunks_fts MATCH ?')
      .all('arch*') as any[];
    expect(results).toHaveLength(1);
  });
});
