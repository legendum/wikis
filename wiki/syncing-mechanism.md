# Syncing Mechanism

The syncing mechanism synchronizes wiki files between a local filesystem and the remote server via API endpoints. Wiki files consist of generated markdown pages (e.g., `index.md`, `architecture.md`) stored in the local project directory and mirrored in the server's per-user SQLite database. It employs a manifest-based approach to efficiently detect changes, generate a sync plan, and execute targeted pushes, pulls, deletions, or conflict resolutions. This design avoids transferring unchanged files, minimizes bandwidth, and resolves conflicts via last-write-wins using modification timestamps.

## Manifest Format

A manifest is a dictionary mapping file paths to metadata: a content hash (SHA-256 prefix) and ISO 8601 modification timestamp. This enables precise change detection without sending file contents during planning.

```typescript
// src/lib/sync.ts
export interface FileEntry {
  hash: string;     // SHA-256 hex prefix (first 16 chars)
  modified: string; // ISO 8601, e.g. "2024-01-15T10:30:00.000Z"
}

export type Manifest = Record<string, FileEntry>;
```

The server builds the remote manifest from the `wiki_files` table:

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

Locally, the CLI scans the filesystem, computes hashes with `hashContent(content)`, and builds a manifest analogously.

## Sync Plan Generation

The core logic resides in `diffManifests(localManifest, remoteManifest)`, which produces a [SyncPlan](api-reference.md#syncplan) dictating actions:

```typescript
// src/lib/sync.ts
export interface SyncPlan {
  push: string[];        // Local newer/new files
  pull: string[];        // Remote newer/new files
  conflicts: string[];   // Changed on both (flagged, resolved by timestamp)
  deleteLocal: string[]; // Deleted remotely
  deleteRemote: string[]; // Deleted locally
}
```

The function iterates over all unique paths:

- Identical hash: Skip (in sync).
- Local-only new: `push`.
- Remote-only new: `pull`.
- Local-only (previously known): `deleteLocal`.
- Remote-only (previously known): `deleteRemote`.
- Divergent hashes:
  - Unchanged since last sync: Push/pull the changed side.
  - Changed both sides: Flag as `conflicts`; resolve via `modified` timestamp (later wins, added to `push` or `pull`).

This last-write-wins strategy prioritizes recency while flagging true conflicts for potential manual review. An optional `lastKnown` manifest tracks prior states but defaults to `{}`.

## API Endpoints

### /api/sync (POST)

The client sends its local manifest; the server responds with a plan.

```typescript
// src/routes/api.ts
.post("/sync", async ({ body, headers }) => {
  const { db } = authGuard(headers);
  const { wiki: wikiName, files: localManifest } = body as {
    wiki: string;
    files: Manifest;
  };

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

Uploads changed files; server upserts into `wiki_files` and indexes for [search-features.md].

```typescript
.post("/push", async ({ body, headers }) => {
  // ... auth + wiki lookup ...
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

Downloads files by path.

```typescript
.post("/pull", async ({ body, headers }) => {
  // ... auth + wiki lookup ...
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

1. Build local manifest from filesystem.
2. POST `/api/sync` with `{wiki, files: localManifest}` → receive plan.
3. **Push**: POST `/api/push` with changed files' contents.
4. **Pull**: POST `/api/pull` with paths → write files locally, update manifest.
5. **Deletes**: Remove files locally/remotely as indicated (server supports via `wiki_files.deleted` flag).
6. Rebuild local manifest; repeat if needed.

This loop ensures eventual consistency with minimal data transfer.

## Conflict Resolution

Conflicts occur when both sides change a file (different hashes). The plan flags them but resolves automatically: the side with the later `modified` timestamp wins (pushed or pulled). This simplifies sync but risks data loss; clients may prompt users for conflicts.

## Design Decisions

- **Efficiency**: Manifests (~1KB) replace full diffs; only changed files transfer.
- **Simplicity**: No three-way merge; last-write-wins avoids complex resolution.
- **Idempotency**: `upsertFile` uses `ON CONFLICT` for safe overwrites.
- **Search Integration**: Pushes trigger [search-features.md] indexing.
- **Wiki Isolation**: Per-wiki (`wiki_id`) scoping prevents cross-project leaks.
- **Auth**: Bearer token via account key ([authentication.md]).

This mechanism powers CLI commands like `wikis sync`, balancing speed and reliability for developer workflows.