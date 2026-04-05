/**
 * Manifest-based sync: compare local vs remote file states,
 * determine what to push, pull, and flag as conflicted.
 */

export interface FileEntry {
  hash: string;
  modified: string; // ISO 8601
}

export type Manifest = Record<string, FileEntry>;

export interface SyncPlan {
  push: string[]; // files to push (local newer or new)
  pull: string[]; // files to pull (remote newer or new)
  conflicts: string[]; // files changed on both sides
  deleteLocal: string[]; // files deleted on remote
  deleteRemote: string[]; // files deleted locally
}

/**
 * Diff two manifests and produce a sync plan.
 * Last-write-wins per file — conflicts are flagged when both sides changed.
 */
export function diffManifests(
  local: Manifest,
  remote: Manifest,
  lastKnown: Manifest = {}
): SyncPlan {
  const plan: SyncPlan = {
    push: [],
    pull: [],
    conflicts: [],
    deleteLocal: [],
    deleteRemote: [],
  };

  const allPaths = new Set([...Object.keys(local), ...Object.keys(remote)]);

  for (const path of allPaths) {
    const l = local[path];
    const r = remote[path];
    const known = lastKnown[path];

    if (l && r) {
      // Both exist
      if (l.hash === r.hash) continue; // in sync

      const localChanged = !known || l.hash !== known.hash;
      const remoteChanged = !known || r.hash !== known.hash;

      if (localChanged && remoteChanged) {
        // Both changed — conflict, last-write-wins
        const localTime = new Date(l.modified).getTime();
        const remoteTime = new Date(r.modified).getTime();
        plan.conflicts.push(path);

        if (localTime >= remoteTime) {
          plan.push.push(path);
        } else {
          plan.pull.push(path);
        }
      } else if (localChanged) {
        plan.push.push(path);
      } else {
        plan.pull.push(path);
      }
    } else if (l && !r) {
      // Local only
      if (known) {
        // Was known before — deleted on remote
        plan.deleteLocal.push(path);
      } else {
        // New local file
        plan.push.push(path);
      }
    } else if (!l && r) {
      // Remote only
      if (known) {
        // Was known before — deleted locally
        plan.deleteRemote.push(path);
      } else {
        // New remote file
        plan.pull.push(path);
      }
    }
  }

  return plan;
}

/**
 * Build a manifest from a list of files with their hashes and modification times.
 */
export function buildManifest(
  files: { path: string; hash: string; modified: string }[]
): Manifest {
  const manifest: Manifest = {};
  for (const f of files) {
    manifest[f.path] = { hash: f.hash, modified: f.modified };
  }
  return manifest;
}
