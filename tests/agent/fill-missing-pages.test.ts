import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { resolve } from "path";
import { createTestDataDir } from "../helpers/db";

/**
 * Tests for fillMissingPages link extraction logic.
 *
 * fillMissingPages scans wiki pages for markdown links to .md files that
 * don't exist, collects surrounding context, then generates them via LLM.
 * We test the link extraction and missing page detection here without
 * invoking the LLM.
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

const SPECIAL = new Set(["index.md", "log.md"]);

/** Same link extraction logic as agent.ts fillMissingPages */
function findMissingLinks(
  db: Database,
  wikiId: number,
): Map<string, { linkText: string; contexts: string[] }> {
  const files = db.prepare(
    "SELECT path FROM wiki_files WHERE wiki_id = ?"
  ).all(wikiId) as { path: string }[];
  const existingPaths = new Set(files.map((f) => f.path));

  const missing = new Map<string, { linkText: string; contexts: string[] }>();
  const linkRe = /\[([^\]]+)\]\(([^)]+\.md)\)/g;

  for (const file of files) {
    if (!file.path.endsWith(".md")) continue;
    const row = db.prepare(
      "SELECT content FROM wiki_files WHERE wiki_id = ? AND path = ?"
    ).get(wikiId, file.path) as { content: string } | null;
    if (!row?.content) continue;

    const lines = row.content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      let match;
      while ((match = linkRe.exec(lines[i])) !== null) {
        const href = match[2].replace(/^\.\//, "");
        if (existingPaths.has(href) || SPECIAL.has(href)) continue;

        if (!missing.has(href)) {
          missing.set(href, { linkText: match[1], contexts: [] });
        }
        const start = Math.max(0, i - 2);
        const end = Math.min(lines.length, i + 3);
        missing.get(href)!.contexts.push(
          `From ${file.path}:\n${lines.slice(start, end).join("\n")}`
        );
      }
    }
  }
  return missing;
}

describe("fillMissingPages link extraction", () => {
  let tmp: { dir: string; cleanup: () => void };
  let db: Database;
  let wikiId: number;

  beforeEach(() => {
    tmp = createTestDataDir();
    db = new Database(resolve(tmp.dir, "test.db"), { create: true });
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(SCHEMA);
    db.prepare("INSERT INTO wikis (name) VALUES (?)").run("test-project");
    wikiId = (db.prepare("SELECT id FROM wikis WHERE name = ?").get("test-project") as { id: number }).id;
  });

  afterEach(() => {
    db.close();
    tmp.cleanup();
  });

  it("finds no missing links when all targets exist", () => {
    db.prepare(
      "INSERT INTO wiki_files (wiki_id, path, content, hash, modified_at) VALUES (?, ?, ?, ?, ?)"
    ).run(wikiId, "overview.md", "See [Setup](setup.md) for details.", "a", "2026-01-01");

    db.prepare(
      "INSERT INTO wiki_files (wiki_id, path, content, hash, modified_at) VALUES (?, ?, ?, ?, ?)"
    ).run(wikiId, "setup.md", "# Setup", "b", "2026-01-01");

    expect(findMissingLinks(db, wikiId).size).toBe(0);
  });

  it("detects a missing link target", () => {
    db.prepare(
      "INSERT INTO wiki_files (wiki_id, path, content, hash, modified_at) VALUES (?, ?, ?, ?, ?)"
    ).run(wikiId, "overview.md", "See [Authentication](auth.md) for details.", "a", "2026-01-01");

    const missing = findMissingLinks(db, wikiId);
    expect(missing.size).toBe(1);
    expect(missing.has("auth.md")).toBe(true);
    expect(missing.get("auth.md")!.linkText).toBe("Authentication");
  });

  it("collects context around the link", () => {
    const content = [
      "# Overview",
      "",
      "The project has an API layer.",
      "See [API Reference](api-reference.md) for endpoints.",
      "It supports REST and GraphQL.",
    ].join("\n");

    db.prepare(
      "INSERT INTO wiki_files (wiki_id, path, content, hash, modified_at) VALUES (?, ?, ?, ?, ?)"
    ).run(wikiId, "overview.md", content, "a", "2026-01-01");

    const missing = findMissingLinks(db, wikiId);
    const ctx = missing.get("api-reference.md")!.contexts[0];
    expect(ctx).toContain("The project has an API layer");
    expect(ctx).toContain("API Reference");
    expect(ctx).toContain("REST and GraphQL");
  });

  it("ignores links to index.md and log.md", () => {
    db.prepare(
      "INSERT INTO wiki_files (wiki_id, path, content, hash, modified_at) VALUES (?, ?, ?, ?, ?)"
    ).run(wikiId, "overview.md", "Back to [Index](index.md) or see [Changelog](log.md).", "a", "2026-01-01");

    expect(findMissingLinks(db, wikiId).size).toBe(0);
  });

  it("strips ./ prefix from link targets", () => {
    db.prepare(
      "INSERT INTO wiki_files (wiki_id, path, content, hash, modified_at) VALUES (?, ?, ?, ?, ?)"
    ).run(wikiId, "overview.md", "See [Deploy](./deploy.md) guide.", "a", "2026-01-01");

    const missing = findMissingLinks(db, wikiId);
    expect(missing.has("deploy.md")).toBe(true);
  });

  it("deduplicates links referenced from multiple pages", () => {
    db.prepare(
      "INSERT INTO wiki_files (wiki_id, path, content, hash, modified_at) VALUES (?, ?, ?, ?, ?)"
    ).run(wikiId, "overview.md", "See [Config](config.md).", "a", "2026-01-01");

    db.prepare(
      "INSERT INTO wiki_files (wiki_id, path, content, hash, modified_at) VALUES (?, ?, ?, ?, ?)"
    ).run(wikiId, "setup.md", "Edit [Config](config.md) to customize.", "b", "2026-01-01");

    const missing = findMissingLinks(db, wikiId);
    expect(missing.size).toBe(1);
    expect(missing.get("config.md")!.contexts).toHaveLength(2);
  });

  it("finds multiple missing links from a single page", () => {
    const content = "See [Auth](auth.md) and [Deploy](deploy.md) and [Monitor](monitor.md).";

    db.prepare(
      "INSERT INTO wiki_files (wiki_id, path, content, hash, modified_at) VALUES (?, ?, ?, ?, ?)"
    ).run(wikiId, "overview.md", content, "a", "2026-01-01");

    const missing = findMissingLinks(db, wikiId);
    expect(missing.size).toBe(3);
    expect(missing.has("auth.md")).toBe(true);
    expect(missing.has("deploy.md")).toBe(true);
    expect(missing.has("monitor.md")).toBe(true);
  });

  it("ignores non-.md links", () => {
    db.prepare(
      "INSERT INTO wiki_files (wiki_id, path, content, hash, modified_at) VALUES (?, ?, ?, ?, ?)"
    ).run(wikiId, "overview.md", "See [Repo](https://github.com/foo/bar) and [Image](logo.png).", "a", "2026-01-01");

    expect(findMissingLinks(db, wikiId).size).toBe(0);
  });
});
