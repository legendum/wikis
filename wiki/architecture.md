# Architecture

wikis.fyi employs a distributed architecture that enables users to maintain AI-generated wikis for their projects. A local CLI daemon monitors source files, detects changes via Git diffs or content hashing, and syncs only diffs to a central server (or self-hosted instance). The server reconstructs full source files incrementally from diffs, executes an LLM agent to generate and update wiki pages, indexes content for search, and serves rendered HTML or raw Markdown. This design prioritizes offline development, privacy by keeping full sources local until diff-synced, bi-directional manifest-based synchronization with last-write-wins conflict resolution, and scalability through per-user SQLite databases in WAL mode. The system runs on Bun with Elysia as the web framework and integrates Ollama for optional embeddings.

## Overview

The CLI daemon (`wikis`) operates locally, watches project sources defined by `wiki/config.yml` globs, and syncs changes via `POST /api/sources`. The server stores reconstructed source files, invokes the LLM agent (`src/lib/agent.ts`) for wiki maintenance, indexes wiki chunks (`src/lib/indexer.ts`), and exposes APIs, web UI via Eta templates, and MCP tools at `/mcp`. Authentication and billing integrate with Legendum.

Key design decisions include:
- **Privacy and decentralization**: Full source files remain local except for diffs synced to the server for reconstruction; no Git history retention on server.
- **Server-side AI**: The agent orchestrates all LLM tasks via `runAgent`, supporting self-hosting without local LLMs. See [ai-generation.md](ai-generation.md).
- **Manifest-based sync**: Bi-directional via hashes and timestamps; conflicts resolve last-write-wins. See [syncing-mechanism.md](syncing-mechanism.md).
- **Per-user isolation**: One SQLite database per user (`user{id}.db` in WAL mode) for separation, backups, and concurrency; global `wikis.db` for users/sessions/account_keys; `public.db` for public wikis. See [database-storage.md](database-storage.md).
- **Hybrid search**: FTS5 retrieves up to 50 keyword candidates (with escaped queries), re-ranked by cosine similarity on Ollama embeddings; FTS5 fallback if unavailable. See [search-features.md](search-features.md).
- **Self-hosting parity**: `wikis serve` disables billing without Legendum keys. See [self-hosting.md](self-hosting.md).
- **Incremental agent**: LLM plans initial sections (≤24 pages from README/tree/existing, avoiding overlaps) only if absent and needed; processes new sections; regenerates only affected pages via `source_files.wiki_paths`; fills missing links recursively (depth ≤3); consolidates redundancies; updates special pages (`index.md`, `log.md`, description) if changes detected.

The server (`src/server.ts`) initializes an Elysia app with static files, health checks, `/llms.txt`, and route groups:

```typescript
const app = new Elysia()
  .get("/health", () => ({ ok: true }))
  .get("/llms.txt", ({ set }) => {
    if (!existsSync(LLMS_TXT)) {
      set.status = 404;
      return "Not found";
    }
    return new Response(Bun.file(LLMS_TXT), {
      headers: { "Content-Type": CONTENT_TYPE_TEXT_UTF8 },
    });
  })
  .get("/public/*", ({ params }) => {
    const path = `${PUBLIC_DIR}/${params["*"]}`;
    const file = Bun.file(path);
    const lower = path.toLowerCase();
    if (lower.endsWith(".md")) {
      return new Response(file, {
        headers: { "Content-Type": CONTENT_TYPE_MARKDOWN_UTF8 },
      });
    }
    if (lower.endsWith(".txt")) {
      return new Response(file, {
        headers: { "Content-Type": CONTENT_TYPE_TEXT_UTF8 },
      });
    }
    return file;
  })
  .use(apiRoutes)
  .use(authRoutes)
  .use(webRoutes)
  .listen({ port: PORT, hostname: HOST });
```

## Core Components

### CLI Daemon

The daemon manages projects via `~/.config/wikis/projects.yml`, using timer-based polling with exponential backoff (5–30 minutes per project) for low overhead instead of file watchers. Git repos use `git diff <last_sha> HEAD`; others hash contents. Changes trigger debounced `POST /api/sources` with diffs; local wiki writes push via `/api/sync`; hourly polls pull remote updates. See [cli-commands.md](cli-commands.md).

### Server

The server processes source ingestion (`src/lib/storage.ts`), agent execution (`src/lib/agent.ts`), indexing (`src/lib/indexer.ts`), APIs, web UI, and MCP (`src/lib/mcp.ts`) at `/mcp`. Elysia groups routes: `/api/*` (sync/sources/search), auth, web.

The agent (`runAgent`) proceeds incrementally:
1. **Plans sections** (if no `config.sections` and (no existing pages or `force=true`)): LLM proposes ≤24 via `planSections` from README/tree/existing.
2. **Consolidates pages**: LLM merges redundancies (`consolidatePages`).
3. **Processes sections**: For new pages only, LLM picks sources (`pickFilesForSection`), generates/updates via `billedChat`/`extractMarkdown`/`upsertFile`, records via `setWikiPaths`, indexes, summarizes change.
4. **Regenerates changed**: `findChangedPages` identifies via `source_files.modified_at > wiki_files.modified_at` using `wiki_paths`; regenerates up to 20 sources per page.
5. **Fills missing**: Scans links recursively (≤3 depth) via `fillMissingPages`, generates stubs.
6. **Consolidates again**.
7. **Updates specials** (if changes): Regenerates `index.md`, appends `log.md`, sets description.

Agent entrypoint:

```typescript
export async function runAgent(
  db: Database,
  wikiId: number,
  config: WikiConfig,
  opts: { reason?: string; force?: boolean } = {},
): Promise<AgentResult> {
  // Plan if needed, consolidate, process sections (new only), regenerate changed, fill missing, consolidate, update index/log/desc if changes
}
```

Billing reserves/settles credits via Legendum (`src/lib/billing.ts`); self-hosted skips. See [ai-generation.md](ai-generation.md).

### Database

Per-user `user{id}.db` (WAL) isolates data. Global `wikis.db` tracks users/account_keys/sessions. `public.db` for public wikis. Schema (`src/lib/db.ts`):

```sql
CREATE TABLE wiki_files (
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

CREATE TABLE source_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wiki_id INTEGER NOT NULL,
    path TEXT NOT NULL,
    content TEXT NOT NULL,
    hash TEXT NOT NULL,
    wiki_paths TEXT NOT NULL DEFAULT '',
    modified_at TEXT NOT NULL DEFAULT (datetime('now')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(wiki_id, path)
);

CREATE TABLE wiki_chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wiki_id INTEGER NOT NULL REFERENCES wikis(id),
    path TEXT NOT NULL,
    chunk_index INTEGER NOT NULL,
    content TEXT NOT NULL,
    embedding BLOB,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(wiki_id, path, chunk_index)
);

CREATE VIRTUAL TABLE wiki_chunks_fts USING fts5(
    path, content, content=wiki_chunks, content_rowid=id,
    tokenize='porter unicode61'
);
```

Triggers sync FTS5. `wiki_paths` (e.g., 'architecture.md,api.md') enables targeted regeneration. `wiki_updates`/`events` log changes/billing.

## Data Flow

1. CLI detects changes, `POST /api/sources` with diffs → upserts `source_files` (`hashContent`), triggers agent.
2. Agent plans/processes/regenerates/fills → upserts `wiki_files` (`upsertFile`), indexes via `indexFile`.
3. Indexing chunks content (`src/lib/chunking.ts`), embeds/stores (`src/lib/rag.ts`/`indexer.ts`: `embed`/`serializeEmbedding`), FTS5 syncs.
4. CLI `/api/sync` exchanges manifest → push/pull wiki files.
5. Queries invoke hybrid search (`src/lib/search.ts`).

Manifest example:

```json
{
  "wiki": "my-project",
  "files": { "index.md": { "hash": "abc123", "modified": "2026-04-04T12:00:00Z" } }
}
```

## Search and Indexing

Search (`src/lib/search.ts`) escapes FTS5 queries (`escapeFtsQuery`: quotes words, `*` prefixes), retrieves ≤50 candidates, re-ranks by embeddings:

```typescript
export async function search(
  db: Database,
  wikiId: number,
  query: string,
  opts: { limit?: number } = {},
): Promise<SearchResult[]> {
  const ftsResults = ftsSearch(db, wikiId, query, 50);
  // Embed query (`embedOne`), cosine sim (`cosineSimilarity`) on candidates (`deserializeEmbedding`), FTS fallback/normalized rank
}
```

Indexing (`src/lib/indexer.ts`) replaces per-file chunks post-agent, embeds asynchronously:

```typescript
export async function indexFile(
  db: Database,
  wikiId: number,
  table: ChunkTable,
  path: string,
  content: string,
  opts: { embeddings?: boolean } = {},
): Promise<number> {
  const chunks = chunkText(path, content);
  // Delete old (`DELETE`), insert chunks, store embeddings (`storeEmbeddings`: `embed`/`serializeEmbedding`)
}
```

## Integration and Extensibility

- **Git**: Daemon uses SHAs for diffs. See [configuration.md](configuration.md).
- **MCP**: Tools (`search_wiki`, `read_page`, `list_pages`, `list_wikis`) at `/mcp`. See [mcp-integration.md](mcp-integration.md).
- **Self-hosting**: `wikis serve`; user LLM keys/Ollama, no billing. See [self-hosting.md](self-hosting.md).
- **Auth**: Legendum account keys (`lak_...`, validated via `validateAccountKey`/`hash`). See [authentication.md](authentication.md).

This architecture delivers performance via incremental updates and hybrid search, privacy via local sources/diffs, and extensibility through MCP/self-hosting.