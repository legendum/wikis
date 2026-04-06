# CLI Commands

## Overview

The "wikis" project provides a command-line interface (CLI) for managing personal AI-generated wikis. This CLI serves as the primary tool for initializing, maintaining, and interacting with wikis in a project directory. It operates as a background daemon that watches source files for changes via Git diffs (when available) or content hashing, pushes changes to a remote server or local instance via the `/api/sources` endpoint for LLM-based wiki regeneration, and performs bi-directional syncs of the local `wiki/` folder. The design emphasizes local-first operations, where wiki content resides in a local `wiki/` folder and syncs explicitly to preserve privacy and user control. A single daemon manages all registered projects machine-wide, applying exponential backoff (starting at 5 minutes, capping at 30 minutes per project) to optimize resource usage. Commands integrate with Git for change detection and support self-hosting.

The CLI runs on Bun for fast execution and straightforward installation. Per-project configuration resides in `wiki/config.yml` (defining sources and exclusions), while global settings like the Legendum account key and API URL appear in `~/.config/wikis/config.yml`. See [Configuration](configuration.md). Registered projects store in `~/.config/wikis/projects.yml`, tracking paths, names, and last check times. Example `projects.yml`:

```yaml
projects:
  - path: /Volumes/Code/wikis
    name: wikis
    last_check: 2026-04-04T12:00:00Z
  - path: /Volumes/Code/depends
    name: depends
    last_check: 2026-04-04T11:55:00Z
```

For setup, see [Installation](installation.md).

## Available Commands

The `wikis` CLI commands are idempotent where applicable, support tab completion, and emit structured logs to `~/.config/wikis/log/`. Invoke `wikis --help` for complete options.

### wikis init

The `wikis init` command initializes a wiki in the current directory. It creates a `wiki/` folder containing `config.yml`, performs an initial source scan based on the config, pushes sources to the server via `POST /api/sources`, and registers the project in `~/.config/wikis/projects.yml`. The server stores sources in the `source_files` table, computes hashes to detect changes, counts existing wiki pages via `SELECT COUNT(*) FROM wiki_files`, and schedules regeneration if needed (sources present but no pages exist, or changes detected). The agent generates initial pages like `index.md` and `log.md` using the process in [AI Generation](ai-generation.md).

Example response from `/api/sources`:

```json
{
  "ok": true,
  "data": {
    "files": 5,
    "changed": 2,
    "queued_regeneration": true
  }
}
```

Design decision: Isolates projects to avoid cross-repository interference. Git integration enables precise diffs immediately.

Example:

```bash
wikis init
```

Produces:

```
my-project/
  wiki/
    config.yml
    index.md
    log.md
```

The daemon launches automatically if idle, queuing the build.

### wikis serve

The `wikis serve` command starts a local web server for browsing the wiki through a full-featured interface with search. It runs the entire service stack, exposing API endpoints such as `/api/sources`, `/api/sync`, `/api/push`, `/api/pull`, `/api/search/:wiki`, and `/mcp`, while serving static assets from `public/` with content negotiation (`.md` files as `text/markdown; charset=utf-8`, `.txt` as `text/plain; charset=utf-8`). See [Self-Hosting](self-hosting.md).

Content negotiation occurs as follows:

```typescript
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
```

Design decision: Mirrors the hosted service at wikis.fyi for identical features, including content negotiation for HTML rendering or raw Markdown access.

Example:

```bash
wikis serve
```

Available at http://localhost:3000. Set LLM keys via environment variables.

### wikis start

The `wikis start` command launches or resumes the background daemon, which monitors all registered projects. It conducts periodic checks with exponential backoff (5 minutes initially, up to 30 minutes), detects source changes via `git diff` (in Git repositories) or hashing, pushes diffs to `/api/sources` (reporting `changed` count and `queued_regeneration` status), and manages wiki syncs. The daemon PID records in `~/.config/wikis/daemon.pid`.

Design decision: A single daemon efficiently scales across projects via per-project backoff, with logging for observability.

Example:

```bash
wikis start
```

### wikis stop

The `wikis stop` command gracefully terminates the daemon, stopping monitoring and syncs while preserving state.

Design decision: Clean shutdowns support reliable restarts.

Example:

```bash
wikis stop
```

### wikis status

The `wikis status` command displays daemon health, registered projects, sync states, last check times, Git SHAs (where applicable), and agent activity.

Design decision: Provides non-intrusive monitoring with Git and timestamp integration.

Examples:

```bash
wikis status        # All projects
wikis status my-project  # Specific project
```

### wikis sync

The `wikis sync` command performs manual bi-directional synchronization via manifest exchange at `/api/sync`. It computes local and remote manifests, diffs them to generate a plan (`push`, `pull`, `conflicts`, `deleteLocal`, `deleteRemote`), executes `POST /api/push` for local changes (upserting to `wiki_files` and indexing chunks), `POST /api/pull` for remote files, and handles deletions and conflicts (last-write-wins, with conflicts saved as `.conflict.md`).

The `/api/sync` endpoint processes manifests as follows:

```typescript
const remoteManifest = getManifest(db, wiki.id);
const plan = diffManifests(localManifest, remoteManifest);
return { ok: true, data: plan };
```

Example `/api/sync` request:

```json
{
  "wiki": "my-project",
  "files": {
    "index.md": { "hash": "abc123", "modified": "2026-04-04T12:00:00Z" },
    "log.md": { "hash": "def456", "modified": "2026-04-04T11:55:00Z" }
  }
}
```

Response contains the plan from `diffManifests`. See [Syncing Mechanism](syncing-mechanism.md).

Design decision: Change-only transfers minimize bandwidth; daemon uses 2-second debouncing for writes and hourly pulls.

Examples:

```bash
wikis sync      # Current project
wikis sync --all  # All projects
```

### wikis search

The `wikis search` command queries wiki pages using FTS5 on `wiki_chunks_fts` (up to 50 candidates with Porter stemming and prefix matching), re-ranked by RAG (cosine similarity on Ollama embeddings from `wiki_chunks.embedding`). It replicates web and MCP logic, falling back to FTS ranking without embeddings. See [Search Features](search-features.md).

The hybrid search combines FTS candidates and vector re-ranking:

```typescript
const ftsResults = ftsSearch(db, wikiId, query, FTS_CANDIDATES);
const queryEmbedding = await embedOne(query);
for (const row of ftsResults) {
  const score = chunkRow?.embedding
    ? cosineSimilarity(queryEmbedding, deserializeEmbedding(chunkRow.embedding))
    : normalizeFtsRank(row.rank, worstRank) * 0.5;
  // ...
}
```

Design decision: Chunk-based search ensures speed; hybrid FTS+RAG provides semantic accuracy.

Example:

```bash
wikis search "sync protocol"
```

Shows ranked excerpts with scores.

### wikis login

The `wikis login` command authenticates via Legendum OAuth (browser flow) or direct account key (`--key`), storing credentials hashed in `~/.config/wikis/config.yml` for Bearer tokens. Direct keys invoke `POST /api/login {key: "lak_..."}`, validating against Legendum's `account(key).whoami()`.

Design decision: Supports cloud sync/billing; `--key` enables CI/automation. See [Authentication](authentication.md).

Examples:

```bash
wikis login             # OAuth
wikis login --key lak_...  # Direct
```

### wikis list

The `wikis list` command lists registered projects from `~/.config/wikis/projects.yml`.

Design decision: Enables quick multi-project oversight.

Example:

```bash
wikis list
```

### wikis remove

The `wikis remove` command unregisters the current project from the daemon, stopping monitoring and syncs without deleting local files.

Design decision: Retains wiki for offline/manual use.

Example:

```bash
wikis remove
```

### wikis update

The `wikis update` command refreshes the CLI by pulling updates into `~/.config/wikis/src` and reinstalling dependencies.

Design decision: Automates maintenance without manual steps.

Example:

```bash
wikis update
```

## Integration Notes

Commands interact with the system described in [Architecture](architecture.md), utilizing [AI Generation](ai-generation.md) for page creation, [Search Features](search-features.md) for queries, [Syncing Mechanism](syncing-mechanism.md) for transfers, [Database Storage](database-storage.md) on the server, and [MCP Integration](mcp-integration.md) for agent tools. Install via [Installation](installation.md).