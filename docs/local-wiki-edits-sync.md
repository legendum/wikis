# Spec: Local wiki edits → server (no AI)

## Goal

Allow humans to edit generated markdown under the project’s `wiki/` folder (typos, omissions, small fixes). The `wikis` daemon should detect those changes and **persist them on the server** like any other wiki file update.

This path must **not** enqueue an LLM regeneration or otherwise trigger the agent — only **direct edits to `wiki_files`** should occur.

## Current behavior

| Direction | Mechanism | Notes |
|-----------|-----------|--------|
| **Sources → server** | `POST /api/sources` | Ingests repo sources; **can** queue wiki regeneration / agent. |
| **Wiki pages ← server** | `POST /api/sync` then `POST /api/pull` | Daemon and `wikis sync` call `/api/sync` with **`files: {}`** (empty manifest), then pull. |
| **Wiki pages → server** | *Not implemented on the client* | Local manifest is never sent, so `/api/sync` never plans a **push** of `wiki/*.md`. |

So today, server → local for generated pages works; **local edits to `wiki/` are overwritten on the next pull** and are never uploaded.

## Why this does not trigger AI (server contract)

- **`POST /api/push`** updates `wiki_files`, hashes, `modified_at`, and the FTS index. It does **not** call `scheduleRegeneration` or the agent.
- **`POST /api/sources`** is what ties source changes to RAG + optional wiki rebuilds.

So: **wiki corrections must use the sync/push pipeline, not the sources pipeline.**

## Proposed behavior

### Daemon (`cli/lib/daemon.ts`) and one-shot sync (`cli/commands/sync.ts`)

After the existing **source** push (unchanged), perform a **wiki** round-trip for each project:

1. **Build a local manifest** for generated pages only:
   - Scan files under `wiki/` that represent pages (e.g. `**/*.md`).
   - **Exclude** `wiki/config.yml` (and any other non-page assets you define).
   - Paths in the manifest must match server paths: **relative to `wiki/`** (e.g. `index.md`, `architecture.md`), same as `wiki_files.path` today.
   - Each entry: `{ hash, modified }` using the **same hash algorithm as the server** (`hashContent` in `src/lib/storage.ts` — SHA-256, **16-character hex prefix**) and **file mtime** as ISO 8601 for `modified` (or document if you standardize on another clock, but it must be comparable for last-write-wins in `diffManifests`).

2. **`POST /api/sync`** with `{ wiki, files: localManifest }`.
   - The response is a full `SyncPlan`: `push`, `pull`, `conflicts`, `deleteLocal`, `deleteRemote` (see `src/lib/sync.ts`).

3. **Apply the plan (order matters)**:
   - **Push** local files in `plan.push`: `POST /api/push` with `{ path, content, modified }` per file (required shape already in `api.ts`).
   - **Deletes** (if you support them in v1): implement or call existing APIs for `deleteRemote` / `deleteLocal` as needed; if not in v1, document as follow-up.
   - **Pull** remote files in `plan.pull`: `POST /api/pull` with the path list, then write under `wiki/` as today.

4. **Idempotency**: Re-running the daemon should converge; after a successful push, the next `/api/sync` should show no pending push for those paths.

### Conflict policy

`diffManifests` already implements **last-write-wins** using `modified` timestamps when both sides changed. The spec accepts that for human edits vs server edits; no new conflict UI is required for v1.

## Non-goals (v1)

- Triggering or skipping the agent based on “who” edited a page (human vs bot) — out of scope; **route choice** (`sources` vs `push`) enforces “no AI” for human wiki edits.
- Changing billing or usage events for manual wiki pushes (reuse whatever `/api/push` does today).

## Documentation / product updates

- Update the **Daemon** section in `docs/SPEC.md` (and any user-facing wiki pages that describe sync) so they state **bidirectional wiki file sync**, not only pull.
- Align `wiki/syncing-mechanism.md` with actual CLI behavior once implemented (it already describes the manifest API; the gap is **client implementation**).

## Acceptance checks

1. Edit a file under `wiki/` locally (no source changes); wait for daemon interval (or run `wikis sync`).
2. Confirm the change appears on the hosted wiki (or local `wikis serve` DB) **without** a new agent run / regeneration job tied to **sources**.
3. Confirm a normal source edit still goes through `/api/sources` and can still queue generation as today.

## Implementation notes (for devs)

- **Reuse** `src/lib/sync.ts` types (`Manifest`, `SyncPlan`) on the client where possible, or keep one source of truth for hash rules.
- **Self-hosted auth**: daemon already sends a bearer; keep the same pattern as existing sync.
- Consider **ordering**: push local wins **before** pull so a just-saved file is not immediately overwritten by stale remote state in edge cases (the plan from `diffManifests` should already encode correct push vs pull; still apply pushes before pulls).

---

*This spec is intentionally small: the HTTP surface already exists; the work is almost entirely in the CLI/daemon wiki manifest + push step.*
