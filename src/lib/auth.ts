import { createHash } from "node:crypto";
import { getGlobalDb } from "./db";

interface AccountKeyUser {
  id: number;
  email: string;
  legendum_token: string | null;
}

/**
 * Validate a Legendum account key (lak_...) against the global DB.
 * Returns the user if valid, null otherwise.
 *
 * For hosted mode, the account key is validated against Legendum's API.
 * For self-hosted, we store a hashed key locally.
 */
export function validateAccountKey(key: string): AccountKeyUser | null {
  if (!key?.startsWith("lak_")) return null;

  const hash = createHash("sha256").update(key).digest("hex");
  const db = getGlobalDb();

  // Check local key store
  const row = db
    .prepare(`
      SELECT u.id, u.email, u.legendum_token
      FROM users u
      JOIN account_keys ak ON ak.user_id = u.id
      WHERE ak.key_hash = ?
    `)
    .get(hash) as AccountKeyUser | null;

  return row;
}

/**
 * Resolve a Bearer token for API/MCP/web CLI: account key (`lak_…`) or opaque
 * `users.legendum_token` (link-key / Chats2Me account token).
 */
export function validateBearerToken(token: string): AccountKeyUser | null {
  const byKey = validateAccountKey(token);
  if (byKey) return byKey;

  const db = getGlobalDb();
  const row = db
    .prepare(
      `SELECT u.id, u.email, u.legendum_token FROM users u WHERE u.legendum_token = ?`,
    )
    .get(token) as AccountKeyUser | null;

  return row ?? null;
}

/**
 * Extract bearer token from Authorization header.
 */
export function extractBearerToken(
  header: string | null | undefined,
): string | null {
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

/**
 * Store an account key for a user (self-hosted mode).
 */
export function storeAccountKey(
  userId: number,
  key: string,
  label = "default",
): void {
  const hash = createHash("sha256").update(key).digest("hex");
  const prefix = key.slice(0, 12);
  const db = getGlobalDb();

  db.prepare(`
    INSERT INTO account_keys (user_id, key_hash, key_prefix, label)
    VALUES (?, ?, ?, ?)
  `).run(userId, hash, prefix, label);
}
