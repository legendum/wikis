import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { resolve } from "path";
import { createTestDataDir } from "../helpers/db";

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

describe("FTS5 triggers", () => {
  let tmp: { dir: string; cleanup: () => void };
  let db: Database;
  let wikiId: number;

  beforeEach(() => {
    tmp = createTestDataDir();
    db = new Database(resolve(tmp.dir, "fts-test.db"), { create: true });
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(SCHEMA);

    db.prepare("INSERT INTO wikis (name) VALUES (?)").run("test");
    wikiId = (db.prepare("SELECT id FROM wikis WHERE name = 'test'").get() as { id: number }).id;
  });

  afterEach(() => {
    db.close();
    tmp.cleanup();
  });

  // --- source_chunks_fts ---

  it("indexes source chunks on insert", () => {
    db.prepare(
      "INSERT INTO source_chunks (wiki_id, path, chunk_index, content) VALUES (?, ?, ?, ?)"
    ).run(wikiId, "src/server.ts", 0, "Elysia app setup with routes and middleware");

    const results = db
      .prepare("SELECT * FROM source_chunks_fts WHERE source_chunks_fts MATCH ?")
      .all("elysia") as { path: string; content: string }[];

    expect(results).toHaveLength(1);
    expect(results[0].path).toBe("src/server.ts");
  });

  it("removes from FTS on delete", () => {
    db.prepare(
      "INSERT INTO source_chunks (wiki_id, path, chunk_index, content) VALUES (?, ?, ?, ?)"
    ).run(wikiId, "src/server.ts", 0, "Elysia app setup");

    db.prepare("DELETE FROM source_chunks WHERE wiki_id = ? AND path = ?").run(
      wikiId,
      "src/server.ts"
    );

    const results = db
      .prepare("SELECT * FROM source_chunks_fts WHERE source_chunks_fts MATCH ?")
      .all("elysia") as any[];

    expect(results).toHaveLength(0);
  });

  it("updates FTS on content update", () => {
    db.prepare(
      "INSERT INTO source_chunks (wiki_id, path, chunk_index, content) VALUES (?, ?, ?, ?)"
    ).run(wikiId, "src/server.ts", 0, "Elysia app setup");

    db.prepare("UPDATE source_chunks SET content = ? WHERE wiki_id = ? AND path = ?").run(
      "Hono app setup with new framework",
      wikiId,
      "src/server.ts"
    );

    const oldResults = db
      .prepare("SELECT * FROM source_chunks_fts WHERE source_chunks_fts MATCH ?")
      .all("elysia") as any[];
    expect(oldResults).toHaveLength(0);

    const newResults = db
      .prepare("SELECT * FROM source_chunks_fts WHERE source_chunks_fts MATCH ?")
      .all("hono") as any[];
    expect(newResults).toHaveLength(1);
  });

  it("supports porter stemming", () => {
    db.prepare(
      "INSERT INTO source_chunks (wiki_id, path, chunk_index, content) VALUES (?, ?, ?, ?)"
    ).run(wikiId, "src/sync.ts", 0, "syncing files between local and remote servers");

    // "sync" should match "syncing" via porter stemmer
    const results = db
      .prepare("SELECT * FROM source_chunks_fts WHERE source_chunks_fts MATCH ?")
      .all("sync") as any[];
    expect(results).toHaveLength(1);
  });

  it("supports boolean queries", () => {
    db.prepare(
      "INSERT INTO source_chunks (wiki_id, path, chunk_index, content) VALUES (?, ?, ?, ?)"
    ).run(wikiId, "src/sync.ts", 0, "sync files to remote server");

    db.prepare(
      "INSERT INTO source_chunks (wiki_id, path, chunk_index, content) VALUES (?, ?, ?, ?)"
    ).run(wikiId, "src/search.ts", 0, "search files in local database");

    const results = db
      .prepare("SELECT * FROM source_chunks_fts WHERE source_chunks_fts MATCH ?")
      .all("files NOT remote") as any[];

    expect(results).toHaveLength(1);
    expect(results[0].path).toBe("src/search.ts");
  });

  it("supports BM25 ranking", () => {
    db.prepare(
      "INSERT INTO source_chunks (wiki_id, path, chunk_index, content) VALUES (?, ?, ?, ?)"
    ).run(wikiId, "src/a.ts", 0, "sync sync sync sync sync");

    db.prepare(
      "INSERT INTO source_chunks (wiki_id, path, chunk_index, content) VALUES (?, ?, ?, ?)"
    ).run(wikiId, "src/b.ts", 0, "sync once then done");

    const results = db
      .prepare(
        "SELECT path, rank FROM source_chunks_fts WHERE source_chunks_fts MATCH ? ORDER BY rank"
      )
      .all("sync") as { path: string; rank: number }[];

    expect(results).toHaveLength(2);
    // Higher term frequency = better (lower) rank
    expect(results[0].path).toBe("src/a.ts");
  });

  it("supports prefix matching", () => {
    db.prepare(
      "INSERT INTO source_chunks (wiki_id, path, chunk_index, content) VALUES (?, ?, ?, ?)"
    ).run(wikiId, "src/arch.ts", 0, "architecture of the system");

    const results = db
      .prepare("SELECT * FROM source_chunks_fts WHERE source_chunks_fts MATCH ?")
      .all("arch*") as any[];
    expect(results).toHaveLength(1);
  });

  // --- wiki_chunks_fts ---

  it("indexes wiki chunks on insert", () => {
    db.prepare(
      "INSERT INTO wiki_chunks (wiki_id, path, chunk_index, content) VALUES (?, ?, ?, ?)"
    ).run(wikiId, "pages/architecture.md", 0, "The system uses a manifest-based sync protocol");

    const results = db
      .prepare("SELECT * FROM wiki_chunks_fts WHERE wiki_chunks_fts MATCH ?")
      .all("manifest") as { path: string }[];

    expect(results).toHaveLength(1);
    expect(results[0].path).toBe("pages/architecture.md");
  });

  it("searches across both source and wiki chunks", () => {
    db.prepare(
      "INSERT INTO source_chunks (wiki_id, path, chunk_index, content) VALUES (?, ?, ?, ?)"
    ).run(wikiId, "src/sync.ts", 0, "bidirectional sync implementation");

    db.prepare(
      "INSERT INTO wiki_chunks (wiki_id, path, chunk_index, content) VALUES (?, ?, ?, ?)"
    ).run(wikiId, "pages/sync.md", 0, "the sync protocol handles bidirectional updates");

    const sourceResults = db
      .prepare("SELECT * FROM source_chunks_fts WHERE source_chunks_fts MATCH ?")
      .all("bidirectional") as any[];

    const wikiResults = db
      .prepare("SELECT * FROM wiki_chunks_fts WHERE wiki_chunks_fts MATCH ?")
      .all("bidirectional") as any[];

    expect(sourceResults).toHaveLength(1);
    expect(wikiResults).toHaveLength(1);
  });
});
