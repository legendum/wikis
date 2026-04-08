/** Small DB/string helpers used by the agent modules. */
import type { Database } from "bun:sqlite";

/** Get the directory tree of all source files for a wiki. */
export function getSourceTree(db: Database, wikiId: number): string {
  const rows = db
    .prepare(
      "SELECT DISTINCT path FROM source_files WHERE wiki_id = ? ORDER BY path",
    )
    .all(wikiId) as { path: string }[];

  const dirs = new Set<string>();
  const lines: string[] = [];
  for (const row of rows) {
    const parts = row.path.split("/");
    for (let i = 0; i < parts.length - 1; i++) {
      const dirPath = parts.slice(0, i + 1).join("/");
      if (!dirs.has(dirPath)) {
        dirs.add(dirPath);
        lines.push(`${"  ".repeat(i)}${parts[i]}/`);
      }
    }
    lines.push(`${"  ".repeat(parts.length - 1)}${parts[parts.length - 1]}`);
  }
  return lines.join("\n");
}

/** Read a source file from the DB. */
export function getSourceFile(
  db: Database,
  wikiId: number,
  path: string,
): string | null {
  const row = db
    .prepare("SELECT content FROM source_files WHERE wiki_id = ? AND path = ?")
    .get(wikiId, path) as { content: string } | null;
  return row?.content ?? null;
}

/** Get all distinct source file paths. */
export function getSourcePaths(db: Database, wikiId: number): string[] {
  const rows = db
    .prepare(
      "SELECT DISTINCT path FROM source_files WHERE wiki_id = ? ORDER BY path",
    )
    .all(wikiId) as { path: string }[];
  return rows.map((r) => r.path);
}

/** Record that these source files contribute to a wiki page. */
export function setWikiPaths(
  db: Database,
  wikiId: number,
  sourcePaths: string[],
  wikiPath: string,
): void {
  for (const srcPath of sourcePaths) {
    const row = db
      .prepare(
        "SELECT wiki_paths FROM source_files WHERE wiki_id = ? AND path = ?",
      )
      .get(wikiId, srcPath) as { wiki_paths: string } | null;
    if (!row) continue;

    const existing = row.wiki_paths ? row.wiki_paths.split(",") : [];
    if (!existing.includes(wikiPath)) {
      existing.push(wikiPath);
      db.prepare(
        "UPDATE source_files SET wiki_paths = ? WHERE wiki_id = ? AND path = ?",
      ).run(existing.join(","), wikiId, srcPath);
    }
  }
}

/** Find wiki pages that need regenerating because their source files changed. */
export function findChangedPages(db: Database, wikiId: number): Set<string> {
  // A source file modified after its wiki page was last built means
  // that wiki page needs regenerating.
  const rows = db
    .prepare(`
    SELECT sf.wiki_paths, sf.modified_at as src_modified
    FROM source_files sf
    WHERE sf.wiki_id = ? AND sf.wiki_paths != ''
  `)
    .all(wikiId) as { wiki_paths: string; src_modified: string }[];

  const pages = new Set<string>();
  for (const row of rows) {
    for (const wikiPath of row.wiki_paths.split(",")) {
      if (!wikiPath) continue;
      const wf = db
        .prepare(
          "SELECT modified_at FROM wiki_files WHERE wiki_id = ? AND path = ?",
        )
        .get(wikiId, wikiPath) as { modified_at: string } | null;
      if (wf && row.src_modified > wf.modified_at) {
        pages.add(wikiPath);
      }
    }
  }
  return pages;
}

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Extract markdown from LLM response (strip code fences if present).
 */
export function extractMarkdown(content: string): string | null {
  if (!content.trim()) return null;

  // Strip outer fence only (LLM closes all fences properly)
  return content
    .replace(/^```(?:markdown|md)?\n?/, "")
    .replace(/\n?```$/, "")
    .trim();
}
