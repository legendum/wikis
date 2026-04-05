import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { DATA_DIR } from "./constants";

// --- Global database: user registry ---

const GLOBAL_SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    legendum_token TEXT,
    db_path TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS account_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    key_hash TEXT NOT NULL UNIQUE,
    key_prefix TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT 'default',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_account_keys_hash ON account_keys(key_hash);
CREATE INDEX IF NOT EXISTS idx_account_keys_user ON account_keys(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
`;

let globalDb: Database | null = null;

export function getGlobalDb(): Database {
  if (globalDb) return globalDb;

  mkdirSync(DATA_DIR, { recursive: true });
  const dbPath = resolve(DATA_DIR, "wikis.db");
  globalDb = new Database(dbPath, { create: true });
  globalDb.exec("PRAGMA journal_mode = WAL");
  globalDb.exec("PRAGMA foreign_keys = ON");
  globalDb.exec(GLOBAL_SCHEMA);
  return globalDb;
}

// --- Per-user database ---

const USER_SCHEMA = `
CREATE TABLE IF NOT EXISTS wikis (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL DEFAULT '',
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

CREATE TABLE IF NOT EXISTS source_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wiki_id INTEGER NOT NULL REFERENCES wikis(id),
    path TEXT NOT NULL,
    content TEXT NOT NULL,
    hash TEXT NOT NULL,
    wiki_paths TEXT NOT NULL DEFAULT '',
    modified_at TEXT NOT NULL DEFAULT (datetime('now')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(wiki_id, path)
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

CREATE TABLE IF NOT EXISTS wiki_updates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wiki_id INTEGER NOT NULL REFERENCES wikis(id),
    path TEXT NOT NULL,
    summary TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_wiki_updates_page ON wiki_updates(wiki_id, path);
CREATE INDEX IF NOT EXISTS idx_wiki_files_wiki ON wiki_files(wiki_id);
CREATE INDEX IF NOT EXISTS idx_source_files_wiki ON source_files(wiki_id);
CREATE INDEX IF NOT EXISTS idx_wiki_chunks_wiki ON wiki_chunks(wiki_id);
CREATE INDEX IF NOT EXISTS idx_wiki_chunks_path ON wiki_chunks(wiki_id, path);
CREATE INDEX IF NOT EXISTS idx_events_period ON events(created_at);
`;

const FTS_SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS wiki_chunks_fts USING fts5(
    path,
    content,
    content=wiki_chunks,
    content_rowid=id,
    tokenize='porter unicode61'
);
`;

const FTS_TRIGGERS = `
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

const userDbs = new Map<number, Database>();

export function getUserDb(userId: number): Database {
  const cached = userDbs.get(userId);
  if (cached) return cached;

  const dbPath = resolve(DATA_DIR, `user${userId}.db`);
  mkdirSync(dirname(dbPath), { recursive: true });

  const db = new Database(dbPath, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(USER_SCHEMA);
  db.exec(FTS_SCHEMA);
  db.exec(FTS_TRIGGERS);

  userDbs.set(userId, db);
  return db;
}

// --- User management helpers ---

export function createUser(email: string): number {
  const db = getGlobalDb();
  const userId = db
    .prepare("INSERT INTO users (email, db_path) VALUES (?, ?) RETURNING id")
    .get(email, "") as { id: number };

  // Set the db_path now that we know the id
  db.prepare("UPDATE users SET db_path = ? WHERE id = ?").run(
    `data/user${userId.id}.db`,
    userId.id
  );

  // Initialise the per-user database
  getUserDb(userId.id);

  return userId.id;
}

export function getUserByEmail(email: string) {
  return getGlobalDb()
    .prepare("SELECT * FROM users WHERE email = ?")
    .get(email) as { id: number; email: string; legendum_token: string | null; db_path: string; created_at: string } | null;
}

export function getUserById(id: number) {
  return getGlobalDb()
    .prepare("SELECT * FROM users WHERE id = ?")
    .get(id) as { id: number; email: string; legendum_token: string | null; db_path: string; created_at: string } | null;
}

// --- Public database (for public wikis) ---

let publicDb: Database | null = null;

export function getPublicDb(): Database {
  if (publicDb) return publicDb;

  mkdirSync(DATA_DIR, { recursive: true });
  const dbPath = resolve(DATA_DIR, "public.db");
  publicDb = new Database(dbPath, { create: true });
  publicDb.exec("PRAGMA journal_mode = WAL");
  publicDb.exec("PRAGMA foreign_keys = ON");
  publicDb.exec(USER_SCHEMA);
  publicDb.exec(FTS_SCHEMA);
  publicDb.exec(FTS_TRIGGERS);
  return publicDb;
}

// --- Cleanup ---

export function closeAll() {
  for (const db of userDbs.values()) db.close();
  userDbs.clear();
  if (globalDb) {
    globalDb.close();
    globalDb = null;
  }
  if (publicDb) {
    publicDb.close();
    publicDb = null;
  }
}
