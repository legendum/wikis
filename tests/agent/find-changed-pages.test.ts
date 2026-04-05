import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import { createTestDataDir } from "../helpers/db";

/**
 * Tests for findChangedPages logic.
 *
 * findChangedPages compares source_files.modified_at vs wiki_files.modified_at
 * for each wiki page listed in source_files.wiki_paths. If a source file was
 * modified after its wiki page was last built, that page needs regenerating.
 *
 * We inline the logic here to test it in isolation without importing agent.ts
 * (which has heavy dependencies).
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS wikis (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL DEFAULT '',
    visibility TEXT NOT NULL DEFAULT 'private',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS wiki_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wiki_id INTEGER NOT NULL REFERENCES wikis(id),
    path TEXT NOT NULL,
    content TEXT,
    hash TEXT NOT NULL,
    modified_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(wiki_id, path)
);
CREATE TABLE IF NOT EXISTS source_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wiki_id INTEGER NOT NULL REFERENCES wikis(id),
    path TEXT NOT NULL,
    content TEXT NOT NULL,
    hash TEXT NOT NULL,
    wiki_paths TEXT NOT NULL DEFAULT '',
    modified_at TEXT NOT NULL DEFAULT (datetime('now')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(wiki_id, path)
);
`;

/** Same logic as agent.ts findChangedPages */
function findChangedPages(db: Database, wikiId: number): Set<string> {
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

describe("findChangedPages", () => {
  let tmp: { dir: string; cleanup: () => void };
  let db: Database;
  let wikiId: number;

  beforeEach(() => {
    tmp = createTestDataDir();
    db = new Database(resolve(tmp.dir, "test.db"), { create: true });
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(SCHEMA);
    db.prepare("INSERT INTO wikis (name) VALUES (?)").run("test-project");
    wikiId = (
      db.prepare("SELECT id FROM wikis WHERE name = ?").get("test-project") as {
        id: number;
      }
    ).id;
  });

  afterEach(() => {
    db.close();
    tmp.cleanup();
  });

  it("returns empty when no source files have wiki_paths", () => {
    db.prepare(
      "INSERT INTO source_files (wiki_id, path, content, hash, modified_at) VALUES (?, ?, ?, ?, ?)",
    ).run(wikiId, "src/app.ts", "code", "abc", "2026-01-01T00:00:00Z");

    expect(findChangedPages(db, wikiId).size).toBe(0);
  });

  it("returns empty when source is older than wiki page", () => {
    db.prepare(
      "INSERT INTO source_files (wiki_id, path, content, hash, wiki_paths, modified_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
      wikiId,
      "src/app.ts",
      "code",
      "abc",
      "overview.md",
      "2026-01-01T00:00:00Z",
    );

    db.prepare(
      "INSERT INTO wiki_files (wiki_id, path, content, hash, modified_at) VALUES (?, ?, ?, ?, ?)",
    ).run(wikiId, "overview.md", "# Overview", "def", "2026-01-02T00:00:00Z");

    expect(findChangedPages(db, wikiId).size).toBe(0);
  });

  it("detects page needing update when source is newer", () => {
    db.prepare(
      "INSERT INTO source_files (wiki_id, path, content, hash, wiki_paths, modified_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
      wikiId,
      "src/app.ts",
      "code v2",
      "abc2",
      "overview.md",
      "2026-01-03T00:00:00Z",
    );

    db.prepare(
      "INSERT INTO wiki_files (wiki_id, path, content, hash, modified_at) VALUES (?, ?, ?, ?, ?)",
    ).run(wikiId, "overview.md", "# Overview", "def", "2026-01-01T00:00:00Z");

    const changed = findChangedPages(db, wikiId);
    expect(changed.size).toBe(1);
    expect(changed.has("overview.md")).toBe(true);
  });

  it("handles comma-separated wiki_paths correctly", () => {
    db.prepare(
      "INSERT INTO source_files (wiki_id, path, content, hash, wiki_paths, modified_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
      wikiId,
      "README.md",
      "readme",
      "abc",
      "overview.md,setup.md,api.md",
      "2026-01-05T00:00:00Z",
    );

    // overview.md is up to date
    db.prepare(
      "INSERT INTO wiki_files (wiki_id, path, content, hash, modified_at) VALUES (?, ?, ?, ?, ?)",
    ).run(wikiId, "overview.md", "# Overview", "def", "2026-01-06T00:00:00Z");

    // setup.md is stale
    db.prepare(
      "INSERT INTO wiki_files (wiki_id, path, content, hash, modified_at) VALUES (?, ?, ?, ?, ?)",
    ).run(wikiId, "setup.md", "# Setup", "ghi", "2026-01-01T00:00:00Z");

    // api.md is stale
    db.prepare(
      "INSERT INTO wiki_files (wiki_id, path, content, hash, modified_at) VALUES (?, ?, ?, ?, ?)",
    ).run(wikiId, "api.md", "# API", "jkl", "2026-01-02T00:00:00Z");

    const changed = findChangedPages(db, wikiId);
    expect(changed.size).toBe(2);
    expect(changed.has("setup.md")).toBe(true);
    expect(changed.has("api.md")).toBe(true);
    expect(changed.has("overview.md")).toBe(false);
  });

  it("does not match partial path names", () => {
    // api.md should NOT match api-overview.md
    db.prepare(
      "INSERT INTO source_files (wiki_id, path, content, hash, wiki_paths, modified_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
      wikiId,
      "src/api.ts",
      "code",
      "abc",
      "api.md",
      "2026-01-05T00:00:00Z",
    );

    db.prepare(
      "INSERT INTO wiki_files (wiki_id, path, content, hash, modified_at) VALUES (?, ?, ?, ?, ?)",
    ).run(wikiId, "api.md", "# API", "def", "2026-01-06T00:00:00Z");

    db.prepare(
      "INSERT INTO wiki_files (wiki_id, path, content, hash, modified_at) VALUES (?, ?, ?, ?, ?)",
    ).run(
      wikiId,
      "api-overview.md",
      "# API Overview",
      "ghi",
      "2026-01-01T00:00:00Z",
    );

    const changed = findChangedPages(db, wikiId);
    // api.md is up to date, api-overview.md should NOT be flagged
    expect(changed.size).toBe(0);
  });

  it("handles multiple source files pointing to same wiki page", () => {
    db.prepare(
      "INSERT INTO source_files (wiki_id, path, content, hash, wiki_paths, modified_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
      wikiId,
      "src/auth.ts",
      "code",
      "abc",
      "auth.md",
      "2026-01-01T00:00:00Z",
    );

    db.prepare(
      "INSERT INTO source_files (wiki_id, path, content, hash, wiki_paths, modified_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
      wikiId,
      "src/session.ts",
      "code",
      "def",
      "auth.md",
      "2026-01-10T00:00:00Z",
    );

    db.prepare(
      "INSERT INTO wiki_files (wiki_id, path, content, hash, modified_at) VALUES (?, ?, ?, ?, ?)",
    ).run(wikiId, "auth.md", "# Auth", "ghi", "2026-01-05T00:00:00Z");

    const changed = findChangedPages(db, wikiId);
    // session.ts is newer than auth.md, so auth.md needs update
    expect(changed.size).toBe(1);
    expect(changed.has("auth.md")).toBe(true);
  });

  it("ignores source files where wiki page does not exist yet", () => {
    db.prepare(
      "INSERT INTO source_files (wiki_id, path, content, hash, wiki_paths, modified_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
      wikiId,
      "src/new.ts",
      "code",
      "abc",
      "new-feature.md",
      "2026-01-10T00:00:00Z",
    );

    // new-feature.md doesn't exist in wiki_files
    const changed = findChangedPages(db, wikiId);
    expect(changed.size).toBe(0);
  });
});
