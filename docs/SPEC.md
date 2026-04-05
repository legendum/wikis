# wikis.fyi — Specification

## Overview

**wikis.fyi** is a personal wiki service powered by LLMs. A background CLI (`wikis`) watches your project files, maintains a local `wiki/` folder of interlinked markdown pages, and syncs it to wikis.fyi for browsing and sharing. Login, linking, and billing are handled by Legendum.

Self-hostable: the same codebase runs at wikis.fyi and locally via `wikis serve`.

## Core concepts

### Wiki

A `wiki/` folder inside a project directory. Contains LLM-generated markdown pages, an index, a changelog, and a `config.yml` that defines what sources feed the wiki and how it's structured.

The LLM owns the wiki content entirely — it creates pages, updates them when sources change, maintains cross-references, and keeps everything consistent. The human reads it; the LLM writes it.

### Sources

Project files that the LLM reads to build the wiki. Defined as glob patterns in `wiki/config.yml`. Sources are never synced to wikis.fyi — they stay local. Only the wiki content syncs.

### Sections

Prescriptive top-level categories defined in `wiki/config.yml`. The LLM **must** create and maintain a page for each section. Sections give the wiki a stable skeleton that doesn't drift as content grows.

## Project layout

```
my-project/
  src/
  docs/
  README.md
  wiki/                         # the wiki (synced to wikis.fyi)
    config.yml                  # wiki configuration
    index.md                    # catalog of all pages (LLM-maintained)
    log.md                      # append-only changelog (LLM-maintained)
    pages/                      # LLM-generated wiki pages
      architecture.md
      api-endpoints.md
      setup-guide.md
      ...
```

## Configuration

### Per-wiki: `wiki/config.yml`

```yaml
name: my-project                # wiki name on wikis.fyi → wikis.fyi/{name}

# What the LLM reads to build/maintain the wiki
sources:
  - src/**/*.ts
  - docs/**/*.md
  - config/**/*.yml
  - public/**/*
  - README.md

# What to exclude from sources
exclude:
  - node_modules/**
  - "*.db"
  - .env
  - wiki/**                     # don't read the wiki as a source

# Prescriptive sections — the LLM must create and maintain a page for each
sections:
  - name: Architecture
    description: How the system is designed — components, data flow, key decisions
  - name: API
    description: Endpoints, protocols, request/response formats
  - name: Setup
    description: Getting started, installation, deployment
  - name: Configuration
    description: Environment variables, config files, feature flags
```

### Global: `~/.config/wikis/config.yml`

```yaml
# Legendum account key for authentication and billing
account_key: lak_...

# Where to sync (default: wikis.fyi hosted service)
api_url: https://wikis.fyi/api    # override for self-hosted
```

## Sync

### Protocol

Bi-directional sync between local `wiki/` and the wikis.fyi server.

**Manifest-based:** each sync round starts with a manifest exchange.

```
POST /api/sync
Authorization: Bearer lak_...

{
  "wiki": "my-project",
  "files": {
    "index.md":              { "hash": "abc123", "modified": "2026-04-04T12:00:00Z" },
    "log.md":                { "hash": "def456", "modified": "2026-04-04T11:55:00Z" },
    "pages/architecture.md": { "hash": "789abc", "modified": "2026-04-04T11:50:00Z" }
  }
}
```

Response:

```json
{
  "push": ["pages/architecture.md"],
  "pull": ["pages/api-endpoints.md"],
  "conflicts": ["index.md"],
  "deleted_remote": ["pages/old-page.md"]
}
```

Client then pushes/pulls the indicated files. Deletions propagate in both directions.

### Conflict resolution

**Last-write-wins per file.** The newer version (by `modified` timestamp) wins. The losing version is saved as `{filename}.conflict.md` so nothing is lost. The LLM or human can reconcile later.

### Sync triggers

1. **On local wiki write:** debounce 2 seconds, then push to remote. After push, pull any remote changes.
2. **Hourly poll:** pull remote changes (catches edits from other machines or the web).
3. **Manual:** `wikis sync` for an immediate bi-directional sync.

### What syncs

Only files inside `wiki/` (excluding `config.yml` — config stays local). Source files never leave the machine.

## Source watching and wiki maintenance

The local daemon is a thin client — it watches source files and pushes changes to the server. The **server** does all LLM work.

### Source change detection

The daemon checks for source changes on a timer with **exponential backoff**: starting at every **5 minutes**, doubling to a cap of **30 minutes** when no changes are found, resetting to 5 minutes when changes are detected.

**Git-aware diffing:** if the project is a Git repo, the daemon tracks the last commit SHA it synced (stored in `wiki/.last_sync`). On each check it runs `git diff <last_sha> HEAD -- <source globs>` to get a precise, minimal diff. After a successful push, it writes the new HEAD SHA to `wiki/.last_sync`. This means:

- Only changed lines are sent to the server, not whole files
- Renamed/moved files are detected cleanly
- Uncommitted changes are ignored — only committed work triggers updates
- No file watcher needed for source detection (just a periodic `git diff`)

**Fallback (no Git):** if the project is not a Git repo, the daemon falls back to content hashing. It keeps a manifest of `{path: sha256}` in `wiki/.last_sync.json` and diffs against current file contents on each check.

### Update flow

When source changes are detected:

1. Local daemon diffs the changed source files since last push
2. Daemon sends the diffs to the server via `POST /api/sources`
3. Server ingests the diffs into its RAG index (Ollama `all-minilm` embeddings)
4. Server's LLM agent reads relevant source chunks + existing wiki pages
5. LLM agent updates/creates wiki pages, updates `index.md`, appends to `log.md`
6. Local daemon pulls the updated wiki pages on next sync

### Server-side RAG

The server maintains a vector index per wiki using **Ollama embeddings** (default: `all-minilm`, 384-dimensional vectors — configurable via `OLLAMA_EMBED_MODEL` to swap in larger models like `nomic-embed-text` or `mxbai-embed-large` without code changes). Runs locally, no external API calls.

**Two indexes per wiki:**

1. **Source index** — chunks from project source files (pushed by the daemon via `POST /api/sources`)
2. **Wiki index** — chunks from the wiki pages themselves (updated whenever pages are written)

### Search strategy: FTS5 first, vectors second

SQLite's **FTS5** (Full-Text Search) is the primary search layer. It's built into SQLite, requires no external dependencies, and is extremely fast — sub-millisecond for most queries.

**FTS5 provides:**
- Full-text keyword and phrase search (`"sync protocol"`)
- Prefix matching (`arch*`)
- Boolean operators (`sync AND conflict NOT resolution`)
- BM25 ranking (relevance scoring out of the box)
- Snippet/highlight extraction

**Search execution order:**

1. **FTS5 search** — fast keyword/phrase match with BM25 ranking. Handles the vast majority of queries.
2. **Vector search** (fallback) — only when FTS5 returns fewer than K results, or when the query is clearly semantic (e.g. "how does the system handle failures" has no exact keyword match). Embeds the query via Ollama `all-minilm`, searches by cosine similarity.
3. **Hybrid** — when both return results, merge and re-rank by a weighted score: `0.7 * fts5_score + 0.3 * cosine_score`.

This means most searches never touch the embedding model — they complete in microseconds via FTS5.

### Indexing flow (on source push)

1. Receive diffs from the daemon
2. Re-chunk affected source files (fixed-size chunks with overlap, respecting line boundaries)
3. Upsert chunks into `source_chunks` table and FTS5 index
4. Compute embeddings via Ollama `all-minilm` (async, non-blocking — FTS5 is available immediately)

### Indexing flow (on wiki update)

1. After the LLM agent writes/updates wiki pages
2. Re-chunk the affected pages
3. Upsert into `wiki_chunks` table and FTS5 index
4. Compute embeddings async

The FTS5 tables (defined in the per-user database schema) use `porter` tokenizer for stemming (e.g. "syncing" matches "sync") and `unicode61` for international text. They are kept in sync with the content tables via triggers.

**Query flow (agent or API search):**

1. Run FTS5 `MATCH` query with BM25 ranking
2. If results < K, fall back to vector cosine similarity
3. Merge, deduplicate, return top-K with file path and surrounding context

This means the LLM agent cost scales with *what changed*, not the total project size. Source content stays on the wikis.fyi server (or the self-hosted instance) — it is not stored in the wiki itself or exposed to readers.

### Search API

Designed to be used by agents (Claude Code, Codex, etc.) and the web UI.

| Endpoint | Auth | Description |
|----------|------|-------------|
| `GET /api/search/{wiki}?q=...` | Bearer `lak_...` | Semantic search across wiki + source chunks |
| `GET /api/search/{wiki}?q=...&scope=wiki` | Bearer `lak_...` | Search wiki pages only |
| `GET /api/search/{wiki}?q=...&scope=sources` | Bearer `lak_...` | Search source chunks only |

Response:

```json
{
  "ok": true,
  "data": {
    "results": [
      {
        "path": "pages/architecture.md",
        "scope": "wiki",
        "chunk": "The sync protocol uses manifest-based diffing...",
        "score": 0.87,
        "context": {
          "before": "## Sync\n\n",
          "after": "\n\nEach file is tracked by content hash."
        }
      }
    ]
  }
}
```

**No data is encrypted at rest** — wiki content and source chunks are stored as plain text in SQLite and on disk. This is intentional: the primary consumers are LLM agents, and encryption would prevent server-side search and RAG from functioning. Access control is handled at the API layer (auth + visibility settings per wiki).

### MCP server

The search API is also exposed as an **MCP (Model Context Protocol) server**, so agents like Claude Code can query wikis as a native tool without writing HTTP calls:

**Tools:**
- `search_wiki` — semantic search across a wiki (params: `wiki`, `query`, `scope?`, `limit?`)
- `read_page` — read a full wiki page (params: `wiki`, `page`)
- `list_pages` — list all pages in a wiki (params: `wiki`)

This makes wikis.fyi a first-class knowledge source for any MCP-capable agent.

### MCP configuration

`wikis init` generates an MCP config file at `wiki/mcp.json` that agents can reference:

```json
{
  "mcpServers": {
    "wikis": {
      "type": "http",
      "url": "https://wikis.fyi/mcp",
      "headers": {
        "Authorization": "Bearer lak_..."
      }
    }
  }
}
```

The `lak_...` account key is read from `~/.config/wikis/config.yml` at init time. For self-hosted instances, the URL points to the local server:

```json
{
  "mcpServers": {
    "wikis": {
      "type": "http",
      "url": "http://localhost:3000/mcp",
      "headers": {
        "Authorization": "Bearer lak_..."
      }
    }
  }
}
```

Agents like Claude Code can include this in their MCP config to get `search_wiki`, `read_page`, and `list_pages` as native tools. The account key scopes access to that user's wikis only.

### What the local daemon does NOT do

- Does not call LLM APIs directly
- Does not edit wiki pages
- Does not store embeddings

The daemon is purely: watch → diff → push sources → pull wiki updates.

## Billing

Metered via Legendum credits (Ⱡ). wikis.fyi is registered as a Legendum service.

### What costs credits

| Action | Cost | Notes |
|--------|------|-------|
| Source push (per diff) | Ⱡ 1 | Each source diff pushed for ingestion |
| Wiki update (per LLM run) | Ⱡ 5 | Server-side LLM agent updates wiki pages |
| Wiki storage (per wiki/month) | Ⱡ 10 | Active wikis only (at least one sync that month) |

### What's free

- All reads (browsing wikis on the web)
- Sync pulls (downloading wiki updates from remote)
- Public wiki page views
- RAG indexing (embeddings are a cost of the service, not the user)
- Self-hosted usage (no Legendum needed)

### Free quota

Each account gets **500 free source pushes**, **100 free LLM updates**, and **1 free wiki** per month. Enough for casual use of a single project wiki.

### Insufficient credits

When a billable action fails due to insufficient balance:

```json
{
  "ok": false,
  "error": "insufficient_credits",
  "message": "Buy credits at legendum.co.uk/account",
  "url": "https://legendum.co.uk/account"
}
```

The CLI prints a clear message and continues operating locally (wiki maintenance still works, sync is paused).

## Authentication

### Browser (web UI)

Login with Legendum (OAuth / identity mode). Legendum email = wikis.fyi identity.

### CLI

```bash
wikis login                       # opens browser for Legendum OAuth
wikis login --key lak_...         # direct account key (for agents/CI)
```

The account key is stored in `~/.config/wikis/config.yml`. The CLI uses it as a bearer token for all API calls. The server calls `POST /api/agent/link-service` on Legendum to establish the service link and get a charging token (same pattern as depends.cc).

## CLI

### Commands

```
wikis start                       # start the background daemon (if not already running)
wikis stop                        # stop the daemon
wikis init                        # register current project: create wiki/ + config.yml, start first build
wikis login                       # authenticate with Legendum
wikis status                      # all projects, sync state, agent activity, daemon health
wikis status <project>            # status for a specific project
wikis sync                        # manual one-shot sync for current project
wikis sync --all                  # manual sync for all registered projects
wikis serve                       # run the full wikis.fyi server locally (self-hosted)
wikis update                      # update the CLI
wikis remove                      # unregister current project from the daemon (does not delete wiki/)
wikis list                        # list all registered projects
```

### Install

```bash
curl -fsSL https://wikis.fyi/install.sh | sh
```

Same mechanism as depends.cc:

1. Checks for `bun` runtime; installs from bun.sh if missing
2. Clones the repo to `~/.config/wikis/src` (or pulls if already exists)
3. Runs `bun install` for dependencies
4. Runs `bun link` — reads the `bin` field in `package.json` (`"wikis": "src/cli.ts"`) and symlinks `wikis` into the global PATH

Update with `wikis update` (runs `git pull && bun install` in `~/.config/wikis/src`).

### One daemon, all projects

A single `wikis` daemon runs per machine. It manages every project that has been registered via `wikis init`.

**`wikis init` flow:**

1. Creates `wiki/` folder and `wiki/config.yml` scaffold in the current project
2. Registers the project path with the daemon (stored in `~/.config/wikis/projects.yml`)
3. Daemon immediately begins the first wiki build — reads sources per config, sends to server, LLM agent generates initial pages
4. If the daemon isn't running, `wikis init` starts it automatically

**`~/.config/wikis/projects.yml`:**

```yaml
projects:
  - path: /Volumes/Code/wikis
    name: wikis
    last_sync_sha: abc123f
    last_check: 2026-04-04T12:00:00Z
  - path: /Volumes/Code/depends
    name: depends
    last_sync_sha: def456a
    last_check: 2026-04-04T11:55:00Z
```

### Daemon

`wikis start` forks a background process that manages all registered projects:

1. Iterates through registered projects on the check interval
2. For each project: detect source changes (git diff or content hash), push diffs if changed
3. Pulls wiki updates from remote for all projects
4. Exponential backoff per project (5 → 30 min) — active projects are checked more often
5. Syncs wiki file changes to remote (debounced 2s per project)
6. Polls remote for changes every hour
7. Writes logs to `~/.config/wikis/log/`
8. PID stored in `~/.config/wikis/daemon.pid`

## Web service

### URL hierarchy

Simple, flat, no usernames in paths:

```
wikis.fyi/                                  — landing page (not signed in) or project list (signed in)
wikis.fyi/?q=                               — search across all visible projects
wikis.fyi/{project}                         — project wiki home (index.md)
wikis.fyi/{project}/?q=                     — search within a project
wikis.fyi/{project}/{category}              — category page (from prescriptive sections)
wikis.fyi/{project}/{category}/?q=          — search within a category
wikis.fyi/{project}/{category}/{page}       — wiki page within a category
wikis.fyi/{project}/{category}/{sub}/{page} — wiki page within a subcategory (optional nesting)
```

**Visibility rules:**

- **Not signed in:** you see public wikis only (curated wikis built from public repos — see below)
- **Signed in:** you see your own private projects. All user projects are always private.

Public and private wikis occupy separate namespaces — public wikis are system-managed and don't conflict with user project names.

### Routes

| Route | Description |
|-------|-------------|
| `GET /` | Landing page (guest) or private project list (signed in) |
| `GET /login` | Login with Legendum |
| `GET /account` | Account overview — projects, usage, linked Legendum account |
| `GET /pricing` | Pricing and how credits work |
| `GET /{project}` | Wiki home — rendered index.md |
| `GET /{project}/{category}` | Category page |
| `GET /{project}/{category}/{page}` | Wiki page |
| `GET /{project}/{category}/{sub}/{page}` | Wiki page in subcategory |

Search is always via `?q=` query param on any level.

### API

| Endpoint | Auth | Description |
|----------|------|-------------|
| `POST /api/sync` | Bearer `lak_...` | Manifest exchange — returns push/pull/conflict lists |
| `POST /api/push` | Bearer `lak_...` | Upload wiki files |
| `POST /api/pull` | Bearer `lak_...` | Download wiki files |
| `POST /api/sources` | Bearer `lak_...` | Push source diffs for RAG ingestion |
| `GET /api/wikis` | Bearer `lak_...` | List user's wikis |
| `DELETE /api/wikis/{name}` | Bearer `lak_...` | Delete a wiki |
| `GET /api/usage` | Bearer `lak_...` | Current month usage and quota |
| `GET /api/events/{wiki}` | Bearer `lak_...` or public | SSE stream — live wiki updates |

### Server-Sent Events (SSE)

The web UI subscribes to `GET /api/events/{wiki}` for live updates. When a `wikis` daemon pushes changes or the LLM agent updates pages, the server emits events to all connected clients for that wiki.

**Event types:**

```
event: page_updated
data: {"path": "pages/architecture.md", "hash": "abc123"}

event: page_created
data: {"path": "pages/new-concept.md", "hash": "def456"}

event: page_deleted
data: {"path": "pages/old-page.md"}

event: sync_complete
data: {"files_pushed": 3, "files_pulled": 1, "conflicts": 0}

event: agent_started
data: {"wiki": "my-project", "reason": "source changes detected"}

event: agent_complete
data: {"wiki": "my-project", "pages_updated": 4, "pages_created": 1}
```

The web UI uses these to:
- Refresh the current page content without a full reload
- Show a toast when new pages are created
- Show agent activity status (e.g. "Updating wiki..." spinner)

For public wikis, SSE requires no auth. For private wikis, the `lak_...` token is passed as a query param: `/api/events/{wiki}?token=lak_...`.

### Tech stack

- **Runtime:** Bun
- **Framework:** Elysia
- **Templating:** Eta (server-side rendered HTML — no React, no SPA)
- **Database:** SQLite (WAL mode) — one database per user
- **Auth:** Legendum (Login with Legendum + account keys)
- **Billing:** Legendum credits via SDK

Server-side rendering with Eta is deliberate: public wiki pages must be indexable by search engines. Every page is a full HTML response — no client-side hydration needed. SSE handles live updates without requiring a JS framework.

### Content negotiation

All wiki page routes support two response formats:

- **HTML** (default) — server-rendered via Eta, styled, with navigation and search. For browsers and search engines.
- **Markdown** — raw markdown source. For agents, CLIs, and programmatic access.

Format is selected by file extension:

| URL | Response |
|-----|----------|
| `wikis.fyi/myproject/architecture` | Rendered HTML page |
| `wikis.fyi/myproject/architecture.md` | Raw markdown |

Agents can just `curl wikis.fyi/myproject/architecture.md` and get clean markdown back. Search results (`?q=`) return HTML by default, or append `.md` to the search path for markdown output.

### Database architecture

**One SQLite database per user**, stored at `data/{user_id}.db`. Benefits:

- **Logical isolation** — no chance of data leaking between users via query bugs
- **Physical isolation** — each user's data is a single file, easy to back up, migrate, or shard
- **Portability** — a user can request their DB and drop it straight into a self-hosted instance
- **Performance** — FTS5 indexes stay small and fast per user, no cross-user contention on writes
- **Deletion** — GDPR/account deletion is `rm data/{user_id}.db`

A small **global database** (`data/wikis.db`) maps users to their per-user DB:

#### Global database: `data/wikis.db`

```sql
CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    legendum_token TEXT,                    -- for charging credits
    db_path TEXT NOT NULL,                  -- e.g. 'data/42.db'
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

#### Per-user database: `data/{user_id}.db`

```sql
CREATE TABLE wikis (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'public')),  -- user wikis are always 'private'; 'public' is for system-managed wikis only
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE wiki_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wiki_id INTEGER NOT NULL REFERENCES wikis(id),
    path TEXT NOT NULL,                     -- e.g. 'pages/architecture.md'
    content TEXT,                           -- file content (remote mode); NULL in self-hosted
    hash TEXT NOT NULL,                     -- content SHA-256
    modified_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(wiki_id, path)
);

-- Source chunks for RAG
CREATE TABLE source_chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wiki_id INTEGER NOT NULL REFERENCES wikis(id),
    path TEXT NOT NULL,                     -- source file path (e.g. 'src/server.ts')
    chunk_index INTEGER NOT NULL,           -- position within file
    content TEXT NOT NULL,                  -- chunk text
    embedding BLOB,                         -- float32 vector (dimensions depend on OLLAMA_EMBED_MODEL)
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(wiki_id, path, chunk_index)
);

-- Wiki page chunks for RAG search
CREATE TABLE wiki_chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wiki_id INTEGER NOT NULL REFERENCES wikis(id),
    path TEXT NOT NULL,                     -- wiki page path (e.g. 'pages/architecture.md')
    chunk_index INTEGER NOT NULL,
    content TEXT NOT NULL,
    embedding BLOB,                         -- float32 vector (dimensions depend on OLLAMA_EMBED_MODEL)
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(wiki_id, path, chunk_index)
);

-- Billing events (source of truth for metering)
CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wiki_id INTEGER REFERENCES wikis(id),
    type TEXT NOT NULL,                     -- 'source_push' | 'wiki_update' | 'storage'
    count INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_wiki_files_wiki ON wiki_files(wiki_id);
CREATE INDEX idx_source_chunks_wiki ON source_chunks(wiki_id);
CREATE INDEX idx_source_chunks_path ON source_chunks(wiki_id, path);
CREATE INDEX idx_wiki_chunks_wiki ON wiki_chunks(wiki_id);
CREATE INDEX idx_wiki_chunks_path ON wiki_chunks(wiki_id, path);
CREATE INDEX idx_events_period ON events(created_at);
```

#### FTS5 tables (in each per-user database)

```sql
CREATE VIRTUAL TABLE source_chunks_fts USING fts5(
    path,
    content,
    content=source_chunks,
    content_rowid=id,
    tokenize='porter unicode61'
);

CREATE VIRTUAL TABLE wiki_chunks_fts USING fts5(
    path,
    content,
    content=wiki_chunks,
    content_rowid=id,
    tokenize='porter unicode61'
);
```

### Storage modes

**Remote (wikis.fyi):** all wiki content is stored in SQLite — the `wiki_files` table holds both metadata and file content. No filesystem storage. This keeps everything in one place for backups, search indexing, and simplicity at scale.

**Self-hosted / local:** wiki content lives in the filesystem (`wiki/` folder). SQLite tracks metadata only (hashes, timestamps). The user browses and edits files directly on disk.

## Project structure

```
src/
  server.ts                       -- Elysia app setup
  routes/
    web.ts                        -- landing, account, wiki viewer
    api.ts                        -- sync, push, pull, wikis, usage
  lib/
    db.ts                         -- SQLite schema and init
    auth.ts                       -- Legendum auth (OAuth + account keys)
    sync.ts                       -- manifest diff, conflict detection
    billing.ts                    -- Legendum charge calls, free quota tracking
    storage.ts                    -- read/write wiki files on disk
    render.ts                     -- markdown → HTML rendering
    search.ts                     -- FTS5 queries, vector fallback, hybrid ranking
    rag.ts                        -- chunking, Ollama embeddings, cosine similarity
    agent.ts                      -- LLM agent: queries RAG, updates wiki pages
    mcp.ts                        -- MCP server: search_wiki, read_page, list_pages
    config.ts                     -- YAML config loading
    log.ts                        -- JSON file logger
cli/
  wikis.ts                        -- CLI entry point (bin: "wikis" in package.json)
  commands/
    init.ts                       -- scaffold wiki/
    login.ts                      -- Legendum auth
    start.ts                      -- daemon launcher
    stop.ts                       -- daemon killer
    status.ts                     -- sync state reporter
    sync.ts                       -- one-shot sync
    serve.ts                      -- local server
  lib/
    daemon.ts                     -- background process management
    watcher.ts                    -- file system watcher (wiki + sources)
    syncer.ts                     -- sync client (manifest, push, pull, sources)
    config.ts                     -- global + per-wiki config loading
tests/
  search/
    fts5.test.ts                  -- FTS5 indexing, querying, ranking, stemming, boolean ops
    rag.test.ts                   -- embedding generation, cosine similarity, vector search
    hybrid.test.ts                -- FTS5 + vector hybrid ranking, fallback behavior
    chunking.test.ts              -- chunk splitting, overlap, boundary handling
  sync/
    manifest.test.ts              -- manifest diffing, push/pull lists, conflict detection
    conflict.test.ts              -- last-write-wins, .conflict.md generation
    git.test.ts                   -- git-aware diffing, .last_sync tracking
  agent/
    update.test.ts                -- LLM agent wiki page generation, section enforcement
    ingest.test.ts                -- source diff ingestion, index/log updates
  api/
    sync.test.ts                  -- sync API endpoints
    search.test.ts                -- search API endpoints, scope filtering
    sources.test.ts               -- source push endpoint
    auth.test.ts                  -- Legendum auth, account key validation
  billing/
    metering.test.ts              -- event recording, free quota enforcement
    legendum.test.ts              -- Legendum charge calls, insufficient credits handling
  db/
    per-user.test.ts              -- per-user DB creation, isolation, schema init
    fts-triggers.test.ts          -- FTS5 sync triggers on insert/update/delete
  cli/
    init.test.ts                  -- wiki/ scaffold generation
    watcher.test.ts               -- source change detection, backoff timing
    daemon.test.ts                -- start/stop/status, PID management
  helpers/
    fixtures.ts                   -- sample wiki content, source files, configs
    ollama.ts                     -- Ollama test helper (ensures all-minilm is available)
    db.ts                         -- ephemeral per-test DB setup/teardown
config/
  wikis.yml                       -- server configuration (ports, billing, search tuning, etc.)
  nginx.conf                      -- Nginx site config for /etc/nginx/sites-available/
views/                            -- Eta templates
public/                           -- static assets
data/                             -- per-user SQLite DBs + global DB (gitignored)
```

## Self-hosted

`wikis serve` runs the full server locally. Same codebase, same features. The differences:

- No Legendum billing (charges are skipped when `LEGENDUM_API_KEY` is not set)
- Auth is optional (single-user mode by default when self-hosted)
- `api_url` in `~/.config/wikis/config.yml` points to `http://localhost:{port}`
- **User provides their own LLM keys** — the server reads them from its environment or config

### Environment variables

**Hosted mode** (wikis.fyi):

```bash
LEGENDUM_API_KEY=lpk_...        # Legendum service API key
LEGENDUM_SECRET=lsk_...         # Legendum service secret
LEGENDUM_BASE_URL=https://legendum.co.uk
```

When these are set, billing is active and the server uses its own LLM keys (operational cost, not user-facing).

**Self-hosted mode** (any one of these):

```bash
CLAUDE_API_KEY=sk-ant-...       # Anthropic
OPENAI_API_KEY=sk-...           # OpenAI
XAI_API_KEY=xai-...             # xAI / Grok
GEMINI_API_KEY=...              # Google Gemini
```

When `LEGENDUM_API_KEY` is not set, the server looks for an LLM API key in the order above and uses the first one found. No billing, no Legendum — the user pays their LLM provider directly.

Ollama for embeddings runs at `http://localhost:11434` by default. Configurable via environment variables:

```bash
OLLAMA_URL=http://localhost:11434   # Ollama endpoint
OLLAMA_EMBED_MODEL=all-minilm       # embedding model (swap for nomic-embed-text, mxbai-embed-large, etc.)
```

When running self-hosted, `wikis serve` starts both the web server and the Ollama embedding pipeline. The local `wikis start` daemon connects to it just like it would connect to wikis.fyi — same protocol, same API, the daemon doesn't know the difference.

## Public wikis

Public wikis are system-managed wikis built from **public repositories** (e.g. popular open-source projects on GitHub). They serve as:

- **SEO landing pages** — search-engine-indexed wiki pages that attract users to wikis.fyi
- **Showcase** — demonstrate what a wikis.fyi wiki looks like, live
- **Free to browse** — no account needed

### How they work

1. wikis.fyi maintains a curated list of public repos to index
2. The server clones/pulls the repo, runs the same source → RAG → LLM agent pipeline
3. Wiki pages are generated and kept up to date as the repo evolves
4. Pages are server-rendered with Eta, fully indexable by search engines
5. Each public wiki links to a CTA: "Build a wiki like this for your project"

### Public wiki URLs

Public wikis live at the same URL hierarchy as private ones:

```
wikis.fyi/linux                             — Linux kernel wiki
wikis.fyi/linux/architecture                — category page
wikis.fyi/linux/architecture/scheduler      — page
```

Public wiki names are reserved — users cannot create private projects with the same name as a public wiki.

### No cost to browse

Public wikis cost nothing to read. The LLM/RAG maintenance cost is an operational expense of running wikis.fyi — it's the marketing budget.

## Future considerations

- **Web editing** — edit wiki pages from the browser (v2)
- **Team wikis** — shared wikis with multiple contributors
- **Webhooks** — notify on wiki updates
- **Custom domains** — `docs.myproject.com` → wikis.fyi/{user}/{wiki}
