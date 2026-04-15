# Syncing Mechanism

The syncing mechanism synchronizes wiki files between a local filesystem and the remote server via API endpoints. Wiki files are generated markdown pages (e.g., `index.md`, `architecture.md`) stored in the local project directory and mirrored in the server's per-user SQLite database within the `wiki_files` table. It uses a manifest-based approach for efficient change detection, plan generation, and execution of targeted pushes, pulls, deletions, or conflict resolutions. This design minimizes bandwidth by avoiding transfers of unchanged files and employs last-write-wins resolution based on modification timestamps.

## Manifest Format

A manifest maps file paths to metadata: a content hash (first 16 characters of SHA-256 hex digest) and an ISO 8601 modification timestamp. Manifests enable change detection without transmitting file contents during planning.

```typescript
// src/lib/sync.ts
export interface FileEntry {
  hash: string;     // SHA-256 hex prefix (first 16 chars)
  modified: string; // ISO 8601, e.g. "2024-01-15T10:30:00.000Z"
}

export type Manifest = Record<string, FileEntry>;
```

The server constructs the remote manifest from all entries in `wiki_files` (including soft-deleted files):

```typescript
// src/lib/storage.ts
export function getManifest(
  db: Database,
  wikiId: number,
): Record<string, { hash: string; modified: string }> {
  const rows = db
    .prepare("SELECT path, hash, modified_at FROM wiki_files WHERE wiki_id = ?")
    .all(wikiId) as { path: string; hash: string; modified_at: string }[];

  const manifest: Record<string, { hash: string; modified: string }> = {};
  for (const row of rows) {
    manifest[row.path] = { hash: row.hash, modified: row.modified_at };
  }
  return manifest;
}
```

The client scans the local filesystem, computes `hashContent(content)` for each file, records `fs.stat.mtime.toISOString()`, and builds an equivalent manifest.

## Sync Plan Generation

The `diffManifests(localManifest, remoteManifest)` function generates a [SyncPlan](api-reference.md#syncplan) specifying required actions:

```typescript
// src/lib/sync.ts
export interface SyncPlan {
  push: string[];        // Local newer/new files
  pull: string[];        // Remote newer/new files
  conflicts: string[];   // Changed on both sides (flagged but resolved by timestamp)
  deleteLocal: string[]; // Deleted remotely (soft-deleted on server)
  deleteRemote: string[]; // Deleted locally (requires server-side marking)
}
```

The algorithm processes all unique paths from both manifests (optionally using a `lastKnown` manifest from the prior sync):

- Identical hash and timestamp: Skip (in sync).
- Local-only path (new): Add to `push`.
- Remote-only path (new): Add to `pull`.
- Local-only (previously known): Add to `deleteLocal`.
- Remote-only (previously known): Add to `deleteRemote`.
- Divergent hashes:
  - One side unchanged: Push or pull the changed side.
  - Both changed: Flag in `conflicts`; resolve via `modified` timestamp (newer wins, added to `push` or `pull`).

This last-write-wins approach prioritizes recency, automatically resolving conflicts while flagging them for user awareness.

## API Endpoints

All endpoints require authentication via Bearer token (account key in hosted mode; implicit local user in [self-hosting.md]). The `authGuard` middleware resolves the user database.

### /api/sync (POST)

The client submits `{ wiki: string; files: Manifest }`. The server auto-creates the wiki if absent and returns the sync plan.

```typescript
// src/routes/api.ts
.post("/sync", async ({ body, headers }) => {
  const { db } = authGuard(headers);
  const b = asObject(body);
  const wikiName = requireString(b, "wiki");
  const localManifest = b.files as Manifest;

  // Get or create wiki
  let wiki = db
    .prepare("SELECT id FROM wikis WHERE name = ?")
    .get(wikiName) as { id: number } | null;
  if (!wiki) {
    db.prepare("INSERT INTO wikis (name) VALUES (?)").run(wikiName);
    wiki = db.prepare("SELECT id FROM wikis WHERE name = ?").get(wikiName) as { id: number };
  }

  const remoteManifest = getManifest(db, wiki.id);
  const plan = diffManifests(localManifest, remoteManifest);

  return { ok: true, data: plan };
})
```

### /api/push (POST)

Uploads specified files `{ wiki: string; files: Array<{ path: string; content: string; modified: string }> }`. Requires existing wiki; upserts via `ON CONFLICT` and indexes chunks for [search-features.md] (embeddings disabled to prioritize speed).

```typescript
.post("/push", async ({ body, headers }) => {
  const { db } = authGuard(headers);
  const b = asObject(body);
  const wikiName = requireString(b, "wiki");
  const files = requireArray(b, "files") as {
    path: string;
    content: string;
    modified: string;
  }[];

  const wiki = db
    .prepare("SELECT id FROM wikis WHERE name = ?")
    .get(wikiName) as { id: number } | null;
  if (!wiki) return { ok: false, error: "wiki_not_found" };

  for (const file of files) {
    upsertFile(db, wiki.id, file.path, file.content, file.modified);
    await indexFile(db, wiki.id, "wiki_chunks", file.path, file.content, {
      embeddings: false,
    });
  }

  return { ok: true, data: { pushed: files.length } };
})
```

### /api/pull (POST)

Retrieves files by path `{ wiki: string; paths: string[] }`. Excludes soft-deleted files (`deleted = TRUE`).

```typescript
.post("/pull", async ({ body, headers }) => {
  const { db } = authGuard(headers);
  const b = asObject(body);
  const wikiName = requireString(b, "wiki");
  const paths = requireArray(b, "paths") as string[];

  const wiki = db
    .prepare("SELECT id FROM wikis WHERE name = ?")
    .get(wikiName) as { id: number } | null;
  if (!wiki) return { ok: false, error: "wiki_not_found" };

  const files = paths
    .map((p) => getFile(db, wiki.id, p))
    .filter((f): f is NonNullable<typeof f> => f != null)
    .map((f) => ({
      path: f.path,
      content: f.content,
      hash: f.hash,
      modified: f.modified_at,
    }));
  return { ok: true, data: { files } };
})
```

## Client Workflow

The CLI (`wikis sync`) executes:

1. Scans local filesystem to build `localManifest`.
2. POST `/api/sync` with `{ wiki, files: localManifest }` → receives `plan`.
3. **Push**: POST `/api/push` with contents of `plan.push` + `plan.conflicts` (where local wins).
4. **Pull**: POST `/api/pull` with `plan.pull` + `plan.conflicts` (where remote wins); writes files locally.
5. **Deletes**:
   - `plan.deleteLocal`: Remove paths from local filesystem (server soft-deleted via `deleted = TRUE`).
   - `plan.deleteRemote`: DELETE `/wikis/${wiki}/pages/${path}` for each (marks server-side `deleted = TRUE`, deletes chunks, triggers regeneration).
6. Rebuilds `localManifest`; repeats if plan non-empty (ensures convergence).

Soft deletes (`deleted = TRUE`) persist in manifests (for detection) but exclude from pulls/views. Regeneration skips deleted pages.

## Conflict Resolution

Divergent files (different hashes) are flagged in `plan.conflicts` but auto-resolved: the newer `modified` timestamp determines push/pull. Clients may log conflicts for review. This avoids complex merges while favoring recency.

## Design Decisions

- **Efficiency**: Small manifests (~1KB) enable cheap planning; only deltas transfer.
- **Simplicity**: No three-way merge; timestamp-based last-write-wins suffices for developer edits vs. AI regenerations.
- **Idempotency**: `upsertFile` uses `ON CONFLICT` for safe overwrites.
- **Search Integration**: Pushes index into [search-features.md] (FTS chunks; embeddings optional).
- **Wiki Isolation**: `wiki_id` scoping prevents leaks across projects.
- **Progressive Creation**: `/sync` creates wikis; `/push`/ `/pull` require existence.
- **Soft Deletes**: Preserve history/manifest presence; filter at read-time.
- **Auth Modes**: Bearer tokens ([authentication.md]); self-hosted skips auth ([self-hosting.md]).

This powers `wikis sync`, enabling seamless local editing with remote AI-generated content and search.