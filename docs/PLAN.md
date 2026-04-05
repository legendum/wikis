# Dev Plan

Missing work and known issues. Using **simpler.pw** as the case study.

## Source-to-wiki tracking

- [x] `wiki_paths` populated for simpler.pw — README.md maps to 4 pages. Fully mapped.
- [ ] The `findChangedPages` query uses `LIKE '%' || ? || '%'` which could false-match (e.g. `api.md` matching `api-overview.md`) — use exact comma-split matching
- [ ] `wiki_paths` not populated for depends (built before the column existed) — needs rebuild

## Agent trigger on source push

- [ ] `POST /api/sources` stores files but does not trigger the agent
- [ ] Agent should periodically check for changes and process them (not immediately on push — avoids thrashing and wasting tokens)
- [ ] Need a polling mechanism: agent checks for changed source files on an interval, regenerates affected wiki pages

## Regeneration on source change

- [ ] When source files change, affected wiki pages are regenerated using the stored file list from `wiki_paths`. If the project structure changed significantly (new files added), the page might miss new relevant sources
- [ ] `updateDescription` and `updateIndex` run on every agent invocation even when nothing changed — should skip if no pages were created/updated

## MCP server

Per SPEC.md, wikis.fyi should expose an MCP server so agents like Claude Code can query wikis as native tools.

- [ ] Implement `src/lib/mcp.ts` with three tools:
  - `search_wiki` — semantic search across a wiki (params: `wiki`, `query`, `limit?`)
  - `read_page` — read a full wiki page (params: `wiki`, `page`)
  - `list_pages` — list all pages in a wiki (params: `wiki`)
- [ ] Mount MCP endpoint at `/mcp` (HTTP transport, Bearer auth via account key)
- [ ] `wikis init` generates `wiki/mcp.json` config — scaffold is already there, just needs the account key wired in

## Tests

- [ ] Tests likely broken by schema changes (`source_chunks` -> `source_files`, removed source FTS)
- [ ] Need test coverage for `findChangedPages` logic
- [ ] Need test coverage for `fillMissingPages` recursion

## Search

- [ ] FTS5 syntax errors still appear in logs for some queries — `escapeFtsQuery` doesn't catch all cases
- [ ] Vector search (embeddings via all-minilm) is enabled but not wired into the web search path — only FTS is used

## Auth / billing

- [ ] Session store is in-memory (`Map`) — sessions lost on restart. Move to DB or cookie-based sessions
- [ ] CLI auth flow (`cli/commands/login.ts`) is a stub — needs Legendum OAuth or `--key lak_...`
- [ ] No billing/credit checks yet — all usage is free
- [ ] No install script for CLI (`curl -fsSL https://wikis.fyi/install.sh | sh`)

## Build script

- [ ] `build-public-wikis.ts` without `--fill` still calls `runAgent` which calls `fillMissingPages` at the end — so `--fill` is redundant on first build. Document or simplify
- [ ] No way to force-regenerate a single page or single wiki without wiping the DB

## Web UI

- [ ] No pagination on wiki index or search results
- [ ] No 404 page styling
- [x] Markdown renderer — added blockquotes, numbered lists, images, nested lists, h4

## CLI daemon (last priority)

All stub commands that need implementing:

- [ ] `start` — fork background daemon, write PID, exponential backoff polling
- [ ] `stop` — read PID, kill daemon
- [ ] `status` — read daemon PID, show project states
- [ ] `sync` — one-shot sync for current project (or `--all`)
- [ ] `list` — read `projects.yml`, list registered projects
- [ ] `remove` — unregister current project from daemon
- [ ] Git-aware source diffing (spec: `git diff <last_sha> HEAD -- <source globs>`)
- [ ] `projects.yml` management (`~/.config/wikis/projects.yml`)

## Punted

- SSE / live updates (`GET /api/events/{wiki}`) — nice to have, not now
