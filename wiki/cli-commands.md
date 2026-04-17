# CLI Commands

## Overview

The `wikis` CLI manages personal AI-generated wikis. It initializes projects, runs a background daemon to watch source files (using Git diffs or hashing), pushes changes to `/api/sources` for server-side LLM regeneration, and syncs the local `wiki/` folder bi-directionally. Local-first design keeps wiki content in `wiki/`, syncing only on demand. A single machine-wide daemon handles all registered projects with exponential backoff (5–30 minutes per project).

Per-project config is in `wiki/config.yml` (sources/excludes). Global config (`~/.config/wikis/config.yml`) holds account key and API URL. Registered projects are in `~/.config/wikis/projects.yml`:

```yaml
projects:
  - path: /path/to/project
    name: project-name
    last_check: 2026-04-04T12:00:00Z
```

See [configuration.md](configuration.md) for details.

## Installation

### Prerequisites

Unix-like shell (Bash/Zsh). Bun (runtime) installs automatically if missing.

### Install Script

```bash
curl -fsSL https://wikis.fyi/public/install.sh | sh
```

Steps:
1. Detects/installs Bun (isolated to `~/.config/wikis`).
2. Clones/updates repo to `~/.config/wikis/src`.
3. Runs `bun install`.
4. Symlinks `wikis` to PATH via `bun link` (`package.json` `"bin": {"wikis": "cli/main.ts"}`).

### Verify and Update

```bash
wikis --help
```

Update CLI:

```bash
wikis update
```

## Commands

| Command | Description | Example |
|---------|-------------|---------|
| `wikis init` | Create `wiki/` + `config.yml`; register project; start first build. Auto-starts daemon. | `wikis init` |
| `wikis start` | Start background daemon (forks; PID in `~/.config/wikis/daemon.pid`). | `wikis start` |
| `wikis stop` | Stop daemon. | `wikis stop` |
| `wikis status [<project>]` | Daemon/projects status, sync state, agent activity. | `wikis status my-project` |
| `wikis sync [--all]` | Manual bi-directional sync (manifest → push/pull). | `wikis sync --all` |
| `wikis serve` | Run full server locally (self-host; http://0.0.0.0:3300). | `wikis serve` |
| `wikis login [--key lak_...]` | Auth with Legendum (OAuth or key; stores in config). | `wikis login` |
| `wikis list` | List registered projects. | `wikis list` |
| `wikis remove` | Unregister current project (keeps `wiki/`). | `wikis remove` |
| `wikis update` | Update CLI (git pull + bun install/link). | `wikis update` |
| `wikis search <query>` | Search wiki pages (via API). | `wikis search "sync protocol"` |
| `wikis open [folder]` | Serve local `wiki/` as HTML (preview; http://localhost:3456). | `wikis open wiki/` |
| `wikis rebuild [--force]` | Trigger server rebuild (`POST /api/rebuild`). | `wikis rebuild my-project --force` |
| `wikis delete <page>` | Delete page locally/server (`DELETE /api/wikis/{name}/pages/{path}`). | `wikis delete architecture.md` |

Run `wikis <command> --help` for details.

### Initialization (`wikis init`)

In any project directory:

```bash
cd my-project
wikis init
```

Creates:

```
my-project/
  wiki/
    config.yml          # Sources/excludes
    index.md            # Page catalog
    log.md              # Changelog
    # AI-generated pages (e.g., architecture.md)
```

Scans sources, queues AI generation via local/server LLMs. Starts daemon.

### Local Serving (`wikis serve`)

Full Elysia server (DB, search, auth):

```bash
wikis serve
```

Serves http://localhost:3300 (configurable via `PORT`/`config/wikis.yml`). Self-hosted mode skips Legendum billing.

### Offline Preview (`wikis open`)

Static HTML renders (no DB/auth/sync):

```bash
wikis open [wiki/]
```

Serves http://localhost:3456.

## Daemon Operation

Daemon polls projects (configurable interval), detects source changes, pushes to `/api/sources` (queues regeneration), syncs `wiki/` via `/api/sync` → `/api/push`/`/api/pull`. Human edits to `wiki/` sync without triggering agent. Backoff per project after errors.

Triggers:
- Source changes: debounce → push sources → pull wiki.
- Hourly: pull remote.
- Manual: `wikis sync`.

See [syncing-mechanism.md](syncing-mechanism.md).

## Self-Hosting

`wikis serve` runs the full stack locally. Bypasses Legendum (local user owns all). Requires one LLM provider:

```bash
export OPENAI_API_KEY=sk-...  # Or CLAUDE/XAI/GEMINI
wikis serve
```

Default models:
- xAI: `grok-4-1-fast-reasoning`
- OpenAI: `gpt-5-mini`
- Google: `gemini-3.1-flash-lite-preview`
- Anthropic: `claude-haiku-4-5`

Embeddings: Ollama (`http://localhost:11434`, `all-minilm`).

Daemon connects via `api_url: http://localhost:3300/api` in `~/.config/wikis/config.yml`.

Server config (`config/wikis.yml`):

```yaml
port: 3300
host: 0.0.0.0
ollama_url: http://localhost:11434
# Omit Legendum keys for self-hosted
```

Health: `curl /health` → `{"ok":true}`.

For production: proxy with Nginx ([self-hosting.md](self-hosting.md)). Users pay LLM provider directly.

See [architecture.md](architecture.md), [database-storage.md](database-storage.md), [authentication.md](authentication.md).

## Troubleshooting

- **Bun not found**: Re-run install script.
- **Permission denied**: Use `sudo` for symlink or add `~/.bun/bin` to PATH.
- **Port in use**: `PORT=8080 wikis serve`.
- **No LLMs**: Self-hosting needs API key; hosted uses Legendum (free tier: 500 pushes/month).
- **Sync fails**: Check `wikis status`; verify `account_key` in config ([authentication.md](authentication.md)).