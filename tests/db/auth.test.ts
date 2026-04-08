import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { createTestDataDir } from "../helpers/db";

/**
 * Tests for the auth helpers (validateAccountKey, extractBearerToken,
 * storeAccountKey). Logic is inlined to avoid pulling in db.ts (which
 * resolves DATA_DIR at import time).
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  legendum_token TEXT,
  db_path TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS account_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  key_hash TEXT NOT NULL UNIQUE,
  key_prefix TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT 'default',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

interface AccountKeyUser {
  id: number;
  email: string;
  legendum_token: string | null;
}

function validateAccountKey(db: Database, key: string): AccountKeyUser | null {
  if (!key?.startsWith("lak_")) return null;
  const hash = createHash("sha256").update(key).digest("hex");
  return db
    .prepare(
      `SELECT u.id, u.email, u.legendum_token
       FROM users u
       JOIN account_keys ak ON ak.user_id = u.id
       WHERE ak.key_hash = ?`,
    )
    .get(hash) as AccountKeyUser | null;
}

function extractBearerToken(header: string | null | undefined): string | null {
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

function storeAccountKey(db: Database, userId: number, key: string): void {
  const hash = createHash("sha256").update(key).digest("hex");
  const prefix = key.slice(0, 12);
  db.prepare(
    "INSERT INTO account_keys (user_id, key_hash, key_prefix, label) VALUES (?, ?, ?, 'default')",
  ).run(userId, hash, prefix);
}

describe("extractBearerToken", () => {
  it("extracts a Bearer token", () => {
    expect(extractBearerToken("Bearer lak_abc123")).toBe("lak_abc123");
  });

  it("is case-insensitive on the scheme", () => {
    expect(extractBearerToken("bearer lak_abc")).toBe("lak_abc");
    expect(extractBearerToken("BEARER lak_abc")).toBe("lak_abc");
  });

  it("returns null for missing/empty header", () => {
    expect(extractBearerToken(null)).toBeNull();
    expect(extractBearerToken(undefined)).toBeNull();
    expect(extractBearerToken("")).toBeNull();
  });

  it("returns null for non-Bearer schemes", () => {
    expect(extractBearerToken("Basic abc:def")).toBeNull();
    expect(extractBearerToken("lak_abc")).toBeNull();
  });
});

describe("validateAccountKey", () => {
  let tmp: { dir: string; cleanup: () => void };
  let db: Database;
  let userId: number;

  beforeEach(() => {
    tmp = createTestDataDir();
    db = new Database(resolve(tmp.dir, "auth.db"), { create: true });
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(SCHEMA);
    userId = (
      db
        .prepare(
          "INSERT INTO users (email, db_path) VALUES (?, ?) RETURNING id",
        )
        .get("alice@example.com", "data/user1.db") as { id: number }
    ).id;
  });

  afterEach(() => {
    db.close();
    tmp.cleanup();
  });

  it("returns null for keys not starting with lak_", () => {
    expect(validateAccountKey(db, "abc123")).toBeNull();
    expect(validateAccountKey(db, "")).toBeNull();
  });

  it("returns null for unknown keys", () => {
    expect(validateAccountKey(db, "lak_unknown")).toBeNull();
  });

  it("returns the user for stored keys", () => {
    storeAccountKey(db, userId, "lak_secret123");
    const user = validateAccountKey(db, "lak_secret123");
    expect(user).not.toBeNull();
    expect(user?.email).toBe("alice@example.com");
    expect(user?.id).toBe(userId);
  });

  it("does not store the raw key (only the hash)", () => {
    storeAccountKey(db, userId, "lak_secret123");
    const row = db
      .prepare("SELECT key_hash, key_prefix FROM account_keys")
      .get() as { key_hash: string; key_prefix: string };
    expect(row.key_hash).not.toContain("secret");
    expect(row.key_hash.length).toBe(64); // sha256 hex
    expect(row.key_prefix).toBe("lak_secret12");
  });

  it("rejects a tampered key with the same prefix", () => {
    storeAccountKey(db, userId, "lak_secret123");
    expect(validateAccountKey(db, "lak_secret124")).toBeNull();
  });
});
