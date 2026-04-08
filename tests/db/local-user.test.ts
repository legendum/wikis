import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import { LOCAL_USER_EMAIL, LOCAL_USER_ID } from "../../src/lib/mode";
import { createTestDataDir } from "../helpers/db";

/**
 * Tests for the self-hosted local-user invariant: there is exactly one
 * user with id `LOCAL_USER_ID`, ensureLocalUser is idempotent, and the
 * row coexists with normal autoincrement user ids.
 *
 * Logic is inlined (matching tests/db/auth.test.ts) to avoid pulling in
 * src/lib/db.ts, which resolves DATA_DIR at import time.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  legendum_token TEXT,
  db_path TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

function ensureLocalUser(db: Database): void {
  db.prepare(
    "INSERT OR IGNORE INTO users (id, email, db_path) VALUES (?, ?, ?)",
  ).run(LOCAL_USER_ID, LOCAL_USER_EMAIL, `data/user${LOCAL_USER_ID}.db`);
}

describe("ensureLocalUser", () => {
  let tmp: { dir: string; cleanup: () => void };
  let db: Database;

  beforeEach(() => {
    tmp = createTestDataDir();
    db = new Database(resolve(tmp.dir, "global.db"), { create: true });
    db.exec(SCHEMA);
  });

  afterEach(() => {
    db.close();
    tmp.cleanup();
  });

  it("creates the local user with id 0 on first call", () => {
    ensureLocalUser(db);
    const row = db
      .prepare("SELECT id, email, db_path FROM users WHERE id = ?")
      .get(LOCAL_USER_ID) as
      | { id: number; email: string; db_path: string }
      | undefined;
    expect(row).toBeDefined();
    expect(row?.id).toBe(0);
    expect(row?.email).toBe(LOCAL_USER_EMAIL);
    expect(row?.db_path).toBe("data/user0.db");
  });

  it("is idempotent — repeated calls do not duplicate or update", () => {
    ensureLocalUser(db);
    ensureLocalUser(db);
    ensureLocalUser(db);
    const count = (
      db.prepare("SELECT COUNT(*) AS c FROM users WHERE id = ?").get(0) as {
        c: number;
      }
    ).c;
    expect(count).toBe(1);
  });

  it("coexists with autoincrement user ids", () => {
    ensureLocalUser(db);
    // Inserting without an explicit id should still get id >= 1.
    const inserted = db
      .prepare("INSERT INTO users (email, db_path) VALUES (?, ?) RETURNING id")
      .get("alice@example.com", "data/user1.db") as { id: number };
    expect(inserted.id).toBeGreaterThanOrEqual(1);

    const all = db.prepare("SELECT id FROM users ORDER BY id").all() as {
      id: number;
    }[];
    expect(all.map((u) => u.id)).toContain(0);
    expect(all.map((u) => u.id)).toContain(inserted.id);
  });
});
