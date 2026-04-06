# Database Storage

## Overview

The "wikis" project employs SQLite as its primary database backend through the Bun SQLite module, providing lightweight, file-based storage with zero-configuration setup, high portability, and seamless operation in both self-hosted and hosted environments. Databases persist user accounts, wiki metadata, generated wiki pages, source files, wiki chunks for search (leveraging FTS5 indexes and vector embeddings), usage events for billing and monitoring, and wiki update logs.

Data isolation occurs across multiple database files: the global database (`data/wikis.db`) manages cross-user registry and authentication; per-user databases (`data/user{id}.db`) handle private wikis and sources; the public database (`data/public.db`) stores shared public wikis. This design bolsters security by blocking cross-user data access, minimizes lock contention for improved concurrency, and facilitates horizontal scaling.

Databases operate in Write-Ahead Logging (WAL) mode to support concurrent reads and writes, with foreign keys enabled for referential integrity. FTS5 virtual tables enable rapid full-text search on wiki content via Porter stemming and Unicode61 tokenization. Vector embeddings, stored as BLOBs from Ollama models such as `all-minilm`, support semantic similarity ranking through cosine distance computations. These elements integrate with [authentication.md] for access control, [syncing-mechanism.md] for file synchronization, [search-features.md] for hybrid FTS+RAG queries, [ai-generation.md] for source-to-wiki mapping and regeneration, and [mcp-integration.md] for tool access.

## Global Database

The global database at `data/wikis.db` centralizes user management, storing accounts, hashed authentication keys, and sessions. It separates identity from wiki data to enhance privacy and streamline per-wiki authorization.

Key tables:

- **users**: User IDs, emails, optional Legendum tokens (for billing), per-user database paths, and creation timestamps.
- **account_keys**: Hashed Legendum account keys (`lak_...`) with prefixes (first 12 characters) and labels for validation.
- **sessions**: Session tokens linked to users for stateful interactions.

Schema initialization from `src/lib/db.ts`:

```typescript
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
```

Cached singleton access:

```typescript
export function getGlobalDb(): Database {
  if (globalDb) return globalDb;

  mkdirSync(DATA_DIR, { recursive: true });
  const dbPath = resolve(DATA_DIR, 'wikis.db');
  globalDb = new Database(dbPath, { create: true });
  globalDb.exec('PRAGMA journal_mode = WAL');
  globalDb.exec('PRAGMA foreign_keys = ON');
  globalDb.exec(GLOBAL_SCHEMA);
  return globalDb;
}
```

Indexes enable fast lookups for [authentication.md].

## Per-User Databases

Per-user databases at `data/user{id}.db` isolate wiki data including metadata, generated pages, ingested sources, chunks, events, and updates. Isolation prevents user interference, supports privacy objectives, and simplifies backups or deletions.

Tables:

- **wikis**: Wiki metadata with unique names, LLM-generated descriptions, visibility (`private` or `public`), and timestamps.
- **wiki_files**: Wiki pages storing paths, content (nullable in filesystem mode), hashes, modification times, and soft-delete flag (`deleted`). Upserts manage syncs; soft deletes retain metadata to avoid regenerating removed pages.
- **source_files**: Full ingested source files with paths, content, hashes, `wiki_paths` (comma-separated derived wiki pages for targeted regeneration), and timestamps. Hash-based change detection in `/api/sources` (from `src/routes/api.ts`) triggers [ai-generation.md].
- **wiki_chunks**: Chunked wiki content for search, including paths, indices, text, and optional embeddings (BLOBs).
- **events**: Usage logs (`source_push`, `wiki_update`, `credits_used`) for [configuration.md] monitoring and billing (nullable `wiki_id` for cross-wiki events).
- **wiki_updates**: Per-page change summaries for changelogs.

Schema from `src/lib/db.ts`:

```typescript
const USER_SCHEMA = `
CREATE TABLE IF NOT EXISTS wikis (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL DEFAULT '',
    visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'public')),
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
    deleted BOOLEAN NOT NULL DEFAULT FALSE,
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
    description TEXT NOT NULL DEFAULT '',
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
```

FTS5 virtual table `wiki_chunks_fts` indexes `path` and `content` from `wiki_chunks`:

```typescript
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
```

Cached access via Map:

```typescript
export function getUserDb(userId: number): Database {
  const cached = userDbs.get(userId);
  if (cached) return cached;

  const dbPath = resolve(DATA_DIR, `user${userId}.db`);
  mkdirSync(dirname(dbPath), { recursive: true });

  const db = new Database(dbPath, { create: true });
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(USER_SCHEMA);
  db.exec(FTS_SCHEMA);
  db.exec(FTS_TRIGGERS);

  userDbs.set(userId, db);
  return db;
}
```

The `wiki_paths` field enables efficient change propagation in [ai-generation.md]: queries compare `source_files.modified_at` against `wiki_files.modified_at` for linked pages, filtering `deleted = FALSE` to skip soft-deleted pages. [search-features.md] employs FTS5 JOINs with `wiki_chunks` for hybrid results. Events log usage with nullable `wiki_id`.

## Public Database

The public database (`data/public.db`) replicates the per-user schema for public wikis (`visibility='public'`), enabling read-only access for demos, SEO, and [mcp-integration.md] without per-user overhead.

Initialization mirrors per-user setup:

```typescript
export function getPublicDb(): Database {
  if (publicDb) return publicDb;

  mkdirSync(DATA_DIR, { recursive: true });
  const dbPath = resolve(DATA_DIR, 'public.db');
  publicDb = new Database(dbPath, { create: true });
  publicDb.exec('PRAGMA journal_mode = WAL');
  publicDb.exec('PRAGMA foreign_keys = ON');
  publicDb.exec(USER_SCHEMA);
  publicDb.exec(FTS_SCHEMA);
  publicDb.exec(FTS_TRIGGERS);
  return publicDb;
}
```

The `/api/mcp` endpoint uses it for unauthenticated queries.

## Database Management

In-memory caching (global singleton, per-user Map, public singleton) optimizes I/O. Graceful shutdown closes connections:

```typescript
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
```

This ensures non-blocking operations in [architecture.md].

## Design Decisions

Per-database isolation scales to numerous users (one file per user), mitigates breaches, and simplifies GDPR deletions (`rm data/user{id}.db`). WAL mode accommodates concurrent API requests. FTS5 provides sub-millisecond keyword search with stemming, phrases, and prefixes; inline BLOB embeddings (e.g., 384-dim from Ollama `all-minilm`) enable RAG without external vector stores. Full source storage with `wiki_paths` optimizes regeneration—only affected pages rebuild, bypassing full scans. Soft deletes on `wiki_files` permit page removal while preserving sync metadata, allowing index rebuilds to exclude them. Events and updates support precise billing and monitoring. Indexes optimize common joins (`wiki_id`, `path`). SQLite's schema-less migrations suit developer wikis. Public DB separation ensures performant, searchable shared content. Content in `wiki_files` remains nullable for filesystem-backed self-hosting, storing full text in hosted mode for centralized backups and indexing.