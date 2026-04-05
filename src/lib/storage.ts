import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";

interface WikiFileRow {
  id: number;
  wiki_id: number;
  path: string;
  content: string | null;
  hash: string;
  modified_at: string;
  created_at: string;
}

/**
 * Hash content with SHA-256.
 */
export function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

/**
 * Upsert a wiki file (remote/DB storage mode).
 */
export function upsertFile(
  db: Database,
  wikiId: number,
  path: string,
  content: string,
  modified: string,
): void {
  const hash = hashContent(content);

  db.prepare(`
    INSERT INTO wiki_files (wiki_id, path, content, hash, modified_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(wiki_id, path) DO UPDATE SET
      content = excluded.content,
      hash = excluded.hash,
      modified_at = excluded.modified_at
  `).run(wikiId, path, content, hash, modified);
}

/**
 * Get a wiki file by path.
 */
export function getFile(
  db: Database,
  wikiId: number,
  path: string,
): WikiFileRow | null {
  return db
    .prepare("SELECT * FROM wiki_files WHERE wiki_id = ? AND path = ?")
    .get(wikiId, path) as WikiFileRow | null;
}

/**
 * Get all files for a wiki.
 */
export function listFiles(db: Database, wikiId: number): WikiFileRow[] {
  return db
    .prepare("SELECT * FROM wiki_files WHERE wiki_id = ? ORDER BY path")
    .all(wikiId) as WikiFileRow[];
}

/**
 * Delete a wiki file.
 */
export function deleteFile(db: Database, wikiId: number, path: string): void {
  db.prepare("DELETE FROM wiki_files WHERE wiki_id = ? AND path = ?").run(
    wikiId,
    path,
  );
}

/**
 * Record a page update summary.
 */
export function recordUpdate(
  db: Database,
  wikiId: number,
  path: string,
  summary: string,
): void {
  db.prepare(
    "INSERT INTO wiki_updates (wiki_id, path, summary) VALUES (?, ?, ?)",
  ).run(wikiId, path, summary);
}

/**
 * Get recent updates for a page.
 */
export function getPageUpdates(
  db: Database,
  wikiId: number,
  path: string,
  limit = 5,
): { summary: string; created_at: string }[] {
  return db
    .prepare(
      "SELECT summary, created_at FROM wiki_updates WHERE wiki_id = ? AND path = ? ORDER BY created_at DESC LIMIT ?",
    )
    .all(wikiId, path, limit) as { summary: string; created_at: string }[];
}

/**
 * Build a manifest from DB wiki files.
 */
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
