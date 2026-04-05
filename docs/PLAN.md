# Dev Plan

Missing work and known issues. Using **simpler.pw** as the case study.

## Source-to-wiki tracking

- [x] `wiki_paths` populated for simpler.pw — README.md maps to 4 pages. Fully mapped.
- [x] `findChangedPages` query fixed — exact comma-split matching instead of LIKE
- [ ] `wiki_paths` not populated for depends (built before the column existed) — needs rebuild

## Agent trigger on source push

- [x] `POST /api/sources` triggers debounced regeneration (15 min timer, resets on further changes)
- [x] Only updates `modified_at` when source content actually changes (hash check)

## Regeneration on source change

- [ ] When source files change, affected wiki pages are regenerated using the stored file list from `wiki_paths`. If the project structure changed significantly (new files added), the page might miss new relevant sources
- [x] `updateDescription` and `updateIndex` skip when no pages were created/updated

## MCP server

- [x] `src/lib/mcp.ts` — `search_wiki`, `read_page`, `list_pages` tools
- [x] Mounted at `POST /api/mcp` (HTTP transport, Bearer auth falls back to public DB)
- [x] `wikis init` wires account key into `wiki/mcp.json` from `~/.config/wikis/config.yaml`

## Tests

- [x] Tests fixed for new schema (`source_files`, wiki-only FTS, no scope)
- [x] `bunfig.toml` excludes `data/repos/` tests — 54 pass, 0 fail
- [x] Test coverage for `findChangedPages` logic (7 tests)
- [x] Test coverage for `fillMissingPages` link extraction (7 tests)

## Search

- [x] FTS5 + RAG re-ranking — same search path for web dropdown, CLI, and API
- [x] `escapeFtsQuery` fixed — handles prefix queries, empty tokens, special chars
- [x] Graceful fallback when Ollama unavailable (FTS-only ranking)
- [x] Debounce bumped to 500ms

## Auth / billing

- [x] Billing: reserve 50 credits → LLM call → settle actual usage → charge shortfall
- [x] Pricing config in `config/pricing.yml` (per-provider rates + markup)
- [x] No billing for public wiki builds or self-hosted users with own API keys
- [x] Session store moved from in-memory `Map` to SQLite `sessions` table
- [x] CLI auth flow: `wikis login --key lak_...` or browser OAuth
- [x] Install script: `curl -fsSL https://wikis.fyi/public/install.sh | sh`

## Build script

- [x] `--force` flag to regenerate all pages: `bun run scripts/build-public-wikis.ts --force`
- [ ] No pagination on wiki index or search results

## Web UI

- [x] Styled 404 page with centered message and back link
- [x] Favicon (`public/wikis.png`)
- [x] Roboto font via Google Fonts
- [x] Markdown renderer — added blockquotes, numbered lists, images, nested lists, h4

## CLI daemon

- [x] `start` — fork background daemon, write PID, exponential backoff polling
- [x] `stop` — read PID, kill daemon
- [x] `status` — show daemon PID, current project state
- [x] `sync` — one-shot sync for current project (or `--all`), stores file hashes
- [x] `list` — read `projects.yaml`, list registered projects
- [x] `remove` — unregister current project
- [x] `login` — `--key lak_...` or browser OAuth flow
- [x] File-hash diffing via `~/.config/wikis/hashes/<project>.json` (no git dependency)
- [x] `projects.yaml` management (`~/.config/wikis/projects.yaml`)

