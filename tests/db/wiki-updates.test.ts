import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import { createTestDataDir } from "../helpers/db";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS wikis (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS wiki_updates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wiki_id INTEGER NOT NULL REFERENCES wikis(id),
    path TEXT NOT NULL,
    summary TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_wiki_updates_page ON wiki_updates(wiki_id, path);
`;

function recordUpdate(
  db: Database,
  wikiId: number,
  path: string,
  summary: string,
): void {
  db.prepare(
    "INSERT INTO wiki_updates (wiki_id, path, summary) VALUES (?, ?, ?)",
  ).run(wikiId, path, summary);
}

function getPageUpdates(
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

describe("wiki_updates", () => {
  let tmp: { dir: string; cleanup: () => void };
  let db: Database;
  let wikiId: number;

  beforeEach(() => {
    tmp = createTestDataDir();
    db = new Database(resolve(tmp.dir, "test.db"), { create: true });
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(SCHEMA);
    db.prepare("INSERT INTO wikis (name) VALUES (?)").run("test");
    wikiId = (
      db.prepare("SELECT id FROM wikis WHERE name = ?").get("test") as {
        id: number;
      }
    ).id;
  });

  afterEach(() => {
    db.close();
    tmp.cleanup();
  });

  it("records and retrieves updates for a page", () => {
    recordUpdate(
      db,
      wikiId,
      "architecture.md",
      "Created: covers system architecture",
    );
    const updates = getPageUpdates(db, wikiId, "architecture.md");
    expect(updates).toHaveLength(1);
    expect(updates[0].summary).toBe("Created: covers system architecture");
  });

  it("returns updates in reverse chronological order", () => {
    // Insert with explicit timestamps to guarantee ordering
    db.prepare(
      "INSERT INTO wiki_updates (wiki_id, path, summary, created_at) VALUES (?, ?, ?, ?)",
    ).run(wikiId, "api.md", "Created: API overview", "2026-01-01 00:00:00");
    db.prepare(
      "INSERT INTO wiki_updates (wiki_id, path, summary, created_at) VALUES (?, ?, ?, ?)",
    ).run(
      wikiId,
      "api.md",
      "Updated: added auth section",
      "2026-01-02 00:00:00",
    );
    db.prepare(
      "INSERT INTO wiki_updates (wiki_id, path, summary, created_at) VALUES (?, ?, ?, ?)",
    ).run(
      wikiId,
      "api.md",
      "Updated: added rate limiting",
      "2026-01-03 00:00:00",
    );
    const updates = getPageUpdates(db, wikiId, "api.md");
    expect(updates).toHaveLength(3);
    expect(updates[0].summary).toContain("rate limiting");
    expect(updates[2].summary).toContain("API overview");
  });

  it("respects the limit parameter", () => {
    for (let i = 0; i < 10; i++) {
      recordUpdate(db, wikiId, "page.md", `Update ${i}`);
    }
    const updates = getPageUpdates(db, wikiId, "page.md", 3);
    expect(updates).toHaveLength(3);
  });

  it("returns empty array for pages with no updates", () => {
    const updates = getPageUpdates(db, wikiId, "nonexistent.md");
    expect(updates).toEqual([]);
  });

  it("isolates updates between different pages", () => {
    recordUpdate(db, wikiId, "a.md", "Update A");
    recordUpdate(db, wikiId, "b.md", "Update B");
    const updatesA = getPageUpdates(db, wikiId, "a.md");
    const updatesB = getPageUpdates(db, wikiId, "b.md");
    expect(updatesA).toHaveLength(1);
    expect(updatesA[0].summary).toBe("Update A");
    expect(updatesB).toHaveLength(1);
    expect(updatesB[0].summary).toBe("Update B");
  });

  it("isolates updates between different wikis", () => {
    db.prepare("INSERT INTO wikis (name) VALUES (?)").run("other");
    const otherWikiId = (
      db.prepare("SELECT id FROM wikis WHERE name = ?").get("other") as {
        id: number;
      }
    ).id;
    recordUpdate(db, wikiId, "page.md", "Wiki 1 update");
    recordUpdate(db, otherWikiId, "page.md", "Wiki 2 update");
    const updates1 = getPageUpdates(db, wikiId, "page.md");
    const updates2 = getPageUpdates(db, otherWikiId, "page.md");
    expect(updates1).toHaveLength(1);
    expect(updates1[0].summary).toBe("Wiki 1 update");
    expect(updates2).toHaveLength(1);
    expect(updates2[0].summary).toBe("Wiki 2 update");
  });
});
