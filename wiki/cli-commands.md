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

The `wikis` CLI commands are idempotent where applicable, support tab completion, and emit structured logs to `~/.config/wikis/log/`. Invoke `wikis --help` for complete options. Commands interact with the server via API endpoints defined in [API Reference](api-reference.md). The daemon process stores its PID in `~/.config/wikis/daemon.pid`.

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

### wikis start

The `wikis start` command starts (or resumes) the background daemon process if it is not already running. The daemon polls all registered projects for source changes using Git diffs or hashing, pushes changed sources via `POST /api/sources`, and performs bi-directional wiki syncs via `POST /api/sync`, `POST /api/push`, and `POST /api/pull`. Polling uses per-project exponential backoff (5 minutes initial, doubling to 30 minutes cap). Starts automatically on `wikis init` if needed.

Example:

```bash
wikis start
```

### wikis stop

The `wikis stop` command terminates the background daemon by sending SIGTERM to the PID in `~/.config/wikis/daemon.pid`. Syncs complete before shutdown.

Example:

```bash
wikis stop
```

### wikis status [<project>]

The `wikis status` command displays the health of the daemon and registered projects. Without `<project>`, shows all projects' sync state, last check times, source change counts, and agent queue status (via server usage). With `<project>`, details the specific project's local manifest vs. remote, pending pushes/pulls, and recent logs.

Example:

```bash
wikis status
wikis status wikis
```

### wikis sync [--all]

The `wikis sync` command triggers a manual bi-directional sync for the current project (or `--all` for every registered project). Builds local `wiki/` manifest, sends `POST /api/sync` to compute push/pull plans via `diffManifests`, executes `POST /api/push` for local changes, and `POST /api/pull` for remote updates. Last-write-wins resolves conflicts; losing versions save as `{path}.conflict.md`. See [Syncing Mechanism](syncing-mechanism.md).

Example:

```bash
wikis sync
wikis sync --all
```

### wikis serve

The `wikis serve` command starts the full wikis.fyi server locally for self-hosting. Listens on configurable port (default from `config/wikis.yml`), handles API routes, web rendering, and MCP integration. No Legendum billing; uses local LLM keys. Daemon syncs to `http://localhost:{port}/api`. See [Self-hosting](self-hosting.md).

Example:

```bash
wikis serve
```

### wikis login [--key <key>]

The `wikis login` command authenticates with Legendum, storing the account key in `~/.config/wikis/config.yml`. Browser flow via `GET /login` → OAuth → `GET /auth/callback`, or `--key lak_...` via `POST /api/login`. Self-hosted skips validation, uses local user.

Example:

```bash
wikis login
wikis login --key lak_...
```

### wikis list

The `wikis list` command lists all registered projects from `~/.config/wikis/projects.yml`, showing paths, names, last check times, and sync status.

Example:

```bash
wikis list
```

### wikis remove

The `wikis remove` command unregisters the current project from `~/.config/wikis/projects.yml`. Does not delete local `wiki/` or server data.

Example:

```bash
wikis remove
```

### wikis update

The `wikis update` command updates the CLI by pulling latest code from the repository to `~/.config/wikis/src` and running `bun install` + `bun link`.

Example:

```bash
wikis update
```

### wikis search <query>

The `wikis search` command searches the current project's wiki via `GET /api/search/{wiki}?q={query}&limit={limit}`. Uses FTS5 for candidates, RAG re-ranking via Ollama embeddings. Displays ranked chunks with paths and scores. Falls back to FTS-only if embeddings unavailable. See [Search Features](search-features.md).

Example:

```bash
wikis search "sync protocol"
```

### wikis open [<folder>]

The `wikis open` command starts a lightweight local server to preview `wiki/` (or specified `<folder>`) as rendered HTML. No database, auth, or sync; useful for offline review.

Example:

```bash
wikis open
wikis open ../other-wiki
```

### wikis rebuild [--force]

The `wikis rebuild` command triggers server-side wiki regeneration via `POST /api/rebuild {wiki: "...", force: true}`. Runs agent asynchronously: plans sections, regenerates changed pages, fills missing links, updates index/log. `--force` rebuilds everything. See [AI Generation](ai-generation.md).

Example:

```bash
wikis rebuild
wikis rebuild --force
```

### wikis delete <page>

The `wikis delete` command deletes a wiki page locally and remotely via `DELETE /api/wikis/{name}/pages/{path}`. Marks `deleted=TRUE` in `wiki_files`, removes chunks, triggers index rebuild. Page path appends `.md` if missing.

Example:

```bash
wikis delete architecture
```