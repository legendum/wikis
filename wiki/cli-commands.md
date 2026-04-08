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