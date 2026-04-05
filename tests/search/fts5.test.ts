import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { resolve } from 'path';
import { indexFile } from '../../src/lib/indexer';
import { search } from '../../src/lib/search';
import { createTestDataDir } from '../helpers/db';

// Minimal schema for search tests — wiki chunks only
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

describe('Search (FTS + RAG re-rank)', () => {
  let tmp: { dir: string; cleanup: () => void };
  let db: Database;
  let wikiId: number;

  beforeEach(async () => {
    tmp = createTestDataDir();
    db = new Database(resolve(tmp.dir, 'search-test.db'), { create: true });
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec(SCHEMA);

    db.prepare('INSERT INTO wikis (name) VALUES (?)').run('test-project');
    wikiId = (
      db.prepare("SELECT id FROM wikis WHERE name = 'test-project'").get() as {
        id: number;
      }
    ).id;

    // Index wiki pages (no embeddings — Ollama likely not running in tests)
    await indexFile(
      db,
      wikiId,
      'wiki_chunks',
      'architecture.md',
      'The system uses Elysia on Bun for the web server with SQLite for persistence',
      { embeddings: false }
    );
    await indexFile(
      db,
      wikiId,
      'wiki_chunks',
      'sync.md',
      'Sync uses a manifest-based protocol with last-write-wins conflict resolution',
      { embeddings: false }
    );
    await indexFile(
      db,
      wikiId,
      'wiki_chunks',
      'setup.md',
      'Install Bun and run bun install to set up dependencies',
      { embeddings: false }
    );
  });

  afterEach(() => {
    db.close();
    tmp.cleanup();
  });

  it('finds wiki pages by keyword', async () => {
    const results = await search(db, wikiId, 'elysia');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].path).toBe('architecture.md');
  });

  it('finds by different keyword', async () => {
    const results = await search(db, wikiId, 'manifest');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].path).toBe('sync.md');
  });

  it('returns empty for no match', async () => {
    const results = await search(db, wikiId, 'nonexistent_term_xyz');
    expect(results).toHaveLength(0);
  });

  it('supports stemming (sync matches syncing)', async () => {
    const results = await search(db, wikiId, 'syncing');
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((r) => r.path === 'sync.md')).toBe(true);
  });

  it('re-indexes a file on update', async () => {
    await indexFile(
      db,
      wikiId,
      'wiki_chunks',
      'architecture.md',
      'Completely new content about authentication and sessions',
      { embeddings: false }
    );

    const oldResults = await search(db, wikiId, 'elysia');
    const newResults = await search(db, wikiId, 'authentication');

    expect(oldResults.filter((r) => r.path === 'architecture.md')).toHaveLength(
      0
    );
    expect(newResults.filter((r) => r.path === 'architecture.md')).toHaveLength(
      1
    );
  });

  it('respects limit', async () => {
    const results = await search(db, wikiId, 'sync OR sqlite OR elysia', {
      limit: 2,
    });
    expect(results.length).toBeLessThanOrEqual(2);
  });

  it('returns results with scores', async () => {
    const results = await search(db, wikiId, 'manifest');
    expect(results.length).toBeGreaterThan(0);
    expect(typeof results[0].score).toBe('number');
  });

  it('gracefully handles no Ollama (FTS-only fallback)', async () => {
    // Without Ollama running, search should still work via FTS
    const results = await search(db, wikiId, 'dependencies');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].path).toBe('setup.md');
  });
});
