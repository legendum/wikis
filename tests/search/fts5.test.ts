import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { resolve } from "path";
import { createTestDataDir } from "../helpers/db";
import { searchFts } from "../../src/lib/search";
import { indexFile } from "../../src/lib/indexer";

// Minimal schema for search tests
const SCHEMA = `
CREATE TABLE IF NOT EXISTS wikis (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    visibility TEXT NOT NULL DEFAULT 'private',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS source_chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wiki_id INTEGER NOT NULL REFERENCES wikis(id),
    path TEXT NOT NULL,
    chunk_index INTEGER NOT NULL,
    content TEXT NOT NULL,
    embedding BLOB,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(wiki_id, path, chunk_index)
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
CREATE VIRTUAL TABLE IF NOT EXISTS source_chunks_fts USING fts5(
    path, content, content=source_chunks, content_rowid=id, tokenize='porter unicode61'
);
CREATE VIRTUAL TABLE IF NOT EXISTS wiki_chunks_fts USING fts5(
    path, content, content=wiki_chunks, content_rowid=id, tokenize='porter unicode61'
);
CREATE TRIGGER IF NOT EXISTS source_chunks_ai AFTER INSERT ON source_chunks BEGIN
    INSERT INTO source_chunks_fts(rowid, path, content) VALUES (new.id, new.path, new.content);
END;
CREATE TRIGGER IF NOT EXISTS source_chunks_ad AFTER DELETE ON source_chunks BEGIN
    INSERT INTO source_chunks_fts(source_chunks_fts, rowid, path, content) VALUES ('delete', old.id, old.path, old.content);
END;
CREATE TRIGGER IF NOT EXISTS source_chunks_au AFTER UPDATE ON source_chunks BEGIN
    INSERT INTO source_chunks_fts(source_chunks_fts, rowid, path, content) VALUES ('delete', old.id, old.path, old.content);
    INSERT INTO source_chunks_fts(rowid, path, content) VALUES (new.id, new.path, new.content);
END;
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

describe("FTS5 search via indexer", () => {
  let tmp: { dir: string; cleanup: () => void };
  let db: Database;
  let wikiId: number;

  beforeEach(async () => {
    tmp = createTestDataDir();
    db = new Database(resolve(tmp.dir, "search-test.db"), { create: true });
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(SCHEMA);

    db.prepare("INSERT INTO wikis (name) VALUES (?)").run("test-project");
    wikiId = (db.prepare("SELECT id FROM wikis WHERE name = 'test-project'").get() as { id: number }).id;

    // Index some source files
    await indexFile(db, wikiId, "source_chunks", "src/server.ts",
      "Elysia app setup with route registration and middleware configuration", { embeddings: false });
    await indexFile(db, wikiId, "source_chunks", "src/lib/sync.ts",
      "Bidirectional sync protocol with manifest-based diffing and conflict resolution", { embeddings: false });
    await indexFile(db, wikiId, "source_chunks", "src/lib/db.ts",
      "SQLite database initialization with WAL mode and FTS5 full-text search indexes", { embeddings: false });

    // Index some wiki pages
    await indexFile(db, wikiId, "wiki_chunks", "pages/architecture.md",
      "The system uses Elysia on Bun for the web server with SQLite for persistence", { embeddings: false });
    await indexFile(db, wikiId, "wiki_chunks", "pages/sync.md",
      "Sync uses a manifest-based protocol with last-write-wins conflict resolution", { embeddings: false });
  });

  afterEach(() => {
    db.close();
    tmp.cleanup();
  });

  it("finds source chunks by keyword", () => {
    const results = searchFts(db, "elysia", { scope: "sources" });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].path).toBe("src/server.ts");
    expect(results[0].scope).toBe("sources");
  });

  it("finds wiki chunks by keyword", () => {
    const results = searchFts(db, "manifest", { scope: "wiki" });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].path).toBe("pages/sync.md");
    expect(results[0].scope).toBe("wiki");
  });

  it("searches both scopes by default", () => {
    const results = searchFts(db, "elysia");
    const scopes = new Set(results.map((r) => r.scope));
    expect(scopes.has("sources")).toBe(true);
    expect(scopes.has("wiki")).toBe(true);
  });

  it("returns empty for no match", () => {
    const results = searchFts(db, "nonexistent_term_xyz");
    expect(results).toHaveLength(0);
  });

  it("supports stemming (sync matches syncing)", () => {
    // "sync" should match content containing "Sync"
    const results = searchFts(db, "syncing", { scope: "sources" });
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((r) => r.path === "src/lib/sync.ts")).toBe(true);
  });

  it("re-indexes a file on update", async () => {
    await indexFile(db, wikiId, "source_chunks", "src/server.ts",
      "Completely new content about authentication and sessions", { embeddings: false });

    const oldResults = searchFts(db, "elysia", { scope: "sources" });
    const newResults = searchFts(db, "authentication", { scope: "sources" });

    expect(oldResults.filter((r) => r.path === "src/server.ts")).toHaveLength(0);
    expect(newResults.filter((r) => r.path === "src/server.ts")).toHaveLength(1);
  });

  it("respects limit", () => {
    const results = searchFts(db, "sync OR sqlite OR elysia", { limit: 2 });
    expect(results.length).toBeLessThanOrEqual(2);
  });
});
