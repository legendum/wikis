import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync } from "fs";
import { resolve } from "path";
import { createTestDataDir } from "../helpers/db";

// We test the schema directly against ephemeral DBs to avoid
// importing src/lib/db.ts which depends on the global DATA_DIR.

const USER_SCHEMA = `
CREATE TABLE IF NOT EXISTS wikis (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    visibility TEXT NOT NULL DEFAULT 'private'
        CHECK (visibility IN ('private', 'public')),
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

CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wiki_id INTEGER REFERENCES wikis(id),
    type TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

const FTS_SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS source_chunks_fts USING fts5(
    path, content,
    content=source_chunks, content_rowid=id,
    tokenize='porter unicode61'
);
CREATE VIRTUAL TABLE IF NOT EXISTS wiki_chunks_fts USING fts5(
    path, content,
    content=wiki_chunks, content_rowid=id,
    tokenize='porter unicode61'
);
`;

const FTS_TRIGGERS = `
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

function initUserDb(path: string): Database {
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(USER_SCHEMA);
  db.exec(FTS_SCHEMA);
  db.exec(FTS_TRIGGERS);
  return db;
}

describe("per-user database", () => {
  let tmp: { dir: string; cleanup: () => void };
  let db: Database;

  beforeEach(() => {
    tmp = createTestDataDir();
    db = initUserDb(resolve(tmp.dir, "test-user.db"));
  });

  afterEach(() => {
    db.close();
    tmp.cleanup();
  });

  it("creates all tables", () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);

    expect(names).toContain("wikis");
    expect(names).toContain("wiki_files");
    expect(names).toContain("source_chunks");
    expect(names).toContain("wiki_chunks");
    expect(names).toContain("events");
  });

  it("creates FTS5 virtual tables", () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%_fts'")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);

    expect(names).toContain("source_chunks_fts");
    expect(names).toContain("wiki_chunks_fts");
  });

  it("enforces unique wiki names", () => {
    db.prepare("INSERT INTO wikis (name) VALUES (?)").run("my-project");
    expect(() => {
      db.prepare("INSERT INTO wikis (name) VALUES (?)").run("my-project");
    }).toThrow();
  });

  it("enforces unique wiki file paths per wiki", () => {
    db.prepare("INSERT INTO wikis (name) VALUES (?)").run("proj");
    const wiki = db.prepare("SELECT id FROM wikis WHERE name = ?").get("proj") as { id: number };

    db.prepare(
      "INSERT INTO wiki_files (wiki_id, path, hash, modified_at) VALUES (?, ?, ?, datetime('now'))"
    ).run(wiki.id, "pages/intro.md", "abc123");

    expect(() => {
      db.prepare(
        "INSERT INTO wiki_files (wiki_id, path, hash, modified_at) VALUES (?, ?, ?, datetime('now'))"
      ).run(wiki.id, "pages/intro.md", "def456");
    }).toThrow();
  });

  it("stores and retrieves wiki file content", () => {
    db.prepare("INSERT INTO wikis (name) VALUES (?)").run("proj");
    const wiki = db.prepare("SELECT id FROM wikis WHERE name = ?").get("proj") as { id: number };

    const content = "# Architecture\n\nThe system uses...";
    db.prepare(
      "INSERT INTO wiki_files (wiki_id, path, content, hash, modified_at) VALUES (?, ?, ?, ?, datetime('now'))"
    ).run(wiki.id, "pages/architecture.md", content, "abc123");

    const row = db
      .prepare("SELECT content FROM wiki_files WHERE wiki_id = ? AND path = ?")
      .get(wiki.id, "pages/architecture.md") as { content: string };

    expect(row.content).toBe(content);
  });

  it("isolates data between two user databases", () => {
    // First user DB
    db.prepare("INSERT INTO wikis (name) VALUES (?)").run("user1-project");

    // Second user DB
    const db2 = initUserDb(resolve(tmp.dir, "test-user-2.db"));
    db2.prepare("INSERT INTO wikis (name) VALUES (?)").run("user2-project");

    const wikis1 = db.prepare("SELECT name FROM wikis").all() as { name: string }[];
    const wikis2 = db2.prepare("SELECT name FROM wikis").all() as { name: string }[];

    expect(wikis1).toHaveLength(1);
    expect(wikis1[0].name).toBe("user1-project");
    expect(wikis2).toHaveLength(1);
    expect(wikis2[0].name).toBe("user2-project");

    db2.close();
  });
});
