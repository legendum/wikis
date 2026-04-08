import type { Database } from "bun:sqlite";
import { Elysia } from "elysia";
import {
  extractBearerToken,
  storeAccountKey,
  validateAccountKey,
} from "../lib/auth";
import {
  createUser,
  ensureLocalUser,
  getPublicDb,
  getUserByEmail,
  getUserDb,
} from "../lib/db";
import { indexFile } from "../lib/indexer";
import { log } from "../lib/log";
import { handleMcpRequest } from "../lib/mcp";
import { isSelfHosted, LOCAL_USER_EMAIL, LOCAL_USER_ID } from "../lib/mode";
import { search } from "../lib/search";
import { getFile, getManifest, hashContent, upsertFile } from "../lib/storage";
import { diffManifests, type Manifest } from "../lib/sync";

/** Assert body is a non-null object. */
function asObject(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("Invalid request body: expected JSON object");
  }
  return body as Record<string, unknown>;
}

/** Assert key is a non-empty string on body. */
function requireString(body: Record<string, unknown>, key: string): string {
  const v = body[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`Invalid request: '${key}' must be a non-empty string`);
  }
  return v;
}

/** Assert key is an array on body. */
function requireArray(body: Record<string, unknown>, key: string): unknown[] {
  const v = body[key];
  if (!Array.isArray(v)) {
    throw new Error(`Invalid request: '${key}' must be an array`);
  }
  return v;
}

/**
 * Auth middleware — extracts user from account key.
 */
function authGuard(headers: Record<string, string | undefined>) {
  // Self-hosted mode: no auth, single local user owns everything.
  if (isSelfHosted()) {
    ensureLocalUser();
    return {
      user: {
        id: LOCAL_USER_ID,
        email: LOCAL_USER_EMAIL,
        legendum_token: null as string | null,
      },
      db: getUserDb(LOCAL_USER_ID),
    };
  }

  const token = extractBearerToken(headers.authorization);
  if (!token) throw new Error("Missing Authorization header");

  const user = validateAccountKey(token);
  if (!user) throw new Error("Invalid account key");

  return { user, db: getUserDb(user.id) };
}

export const apiRoutes = new Elysia({ prefix: "/api" })

  // --- Sync ---

  .post("/sync", async ({ body, headers }) => {
    const { db } = authGuard(headers);
    const b = asObject(body);
    const wikiName = requireString(b, "wiki");
    const localManifest = b.files as Manifest;
    if (!localManifest || typeof localManifest !== "object") {
      throw new Error("Invalid request: 'files' must be a manifest object");
    }

    // Get or create wiki
    let wiki = db
      .prepare("SELECT id FROM wikis WHERE name = ?")
      .get(wikiName) as { id: number } | null;
    if (!wiki) {
      db.prepare("INSERT INTO wikis (name) VALUES (?)").run(wikiName);
      wiki = db
        .prepare("SELECT id FROM wikis WHERE name = ?")
        .get(wikiName) as { id: number };
    }

    const remoteManifest = getManifest(db, wiki.id);
    const plan = diffManifests(localManifest, remoteManifest);

    return { ok: true, data: plan };
  })

  .post("/push", async ({ body, headers }) => {
    const { db } = authGuard(headers);
    const b = asObject(body);
    const wikiName = requireString(b, "wiki");
    const files = requireArray(b, "files") as {
      path: string;
      content: string;
      modified: string;
    }[];

    const wiki = db
      .prepare("SELECT id FROM wikis WHERE name = ?")
      .get(wikiName) as { id: number } | null;
    if (!wiki) return { ok: false, error: "wiki_not_found" };

    for (const file of files) {
      upsertFile(db, wiki.id, file.path, file.content, file.modified);
      // Index wiki content for search
      await indexFile(db, wiki.id, "wiki_chunks", file.path, file.content, {
        embeddings: false,
      });
    }

    return { ok: true, data: { pushed: files.length } };
  })

  .post("/pull", async ({ body, headers }) => {
    const { db } = authGuard(headers);
    const b = asObject(body);
    const wikiName = requireString(b, "wiki");
    const paths = requireArray(b, "paths") as string[];

    const wiki = db
      .prepare("SELECT id FROM wikis WHERE name = ?")
      .get(wikiName) as { id: number } | null;
    if (!wiki) return { ok: false, error: "wiki_not_found" };

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

  // --- Source ingestion ---

  .post("/sources", async ({ body, headers }) => {
    try {
      const { user, db } = authGuard(headers);
      const b = asObject(body);
      const wikiName = requireString(b, "wiki");
      const files = requireArray(b, "files") as {
        path: string;
        content: string;
      }[];

      const wiki = db
        .prepare("SELECT id FROM wikis WHERE name = ?")
        .get(wikiName) as { id: number } | null;
      if (!wiki) return { ok: false, error: "wiki_not_found" };

      // Store source files — only update modified_at when content changed
      const now = new Date().toISOString();
      let changed = 0;
      for (const file of files) {
        const hash = hashContent(file.content);
        const existing = db
          .prepare(
            "SELECT hash FROM source_files WHERE wiki_id = ? AND path = ?",
          )
          .get(wiki.id, file.path) as { hash: string } | null;

        if (existing?.hash === hash) continue;

        db.prepare(`
          INSERT INTO source_files (wiki_id, path, content, hash, modified_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(wiki_id, path) DO UPDATE SET
            content = excluded.content,
            hash = excluded.hash,
            modified_at = excluded.modified_at
        `).run(wiki.id, file.path, file.content, hash, now);
        changed++;
      }

      const wikiPageCount = (
        db
          .prepare("SELECT COUNT(*) as c FROM wiki_files WHERE wiki_id = ?")
          .get(wiki.id) as { c: number }
      ).c;
      // Sources can match the DB (changed === 0) while no wiki pages exist yet — e.g. first
      // upload succeeded but the agent never ran, or only source_files were restored.
      const needsInitialBuild = files.length > 0 && wikiPageCount === 0;

      const { scheduleRegeneration } = await import("../lib/regenerator");
      const dbPath = `user${user.id}`;
      const wikiConfig = { name: wikiName, legendumToken: user.legendum_token };

      const wantsBuild = changed > 0 || needsInitialBuild;
      const queuedRegeneration = wantsBuild
        ? scheduleRegeneration(dbPath, db, wiki.id, wikiConfig, {
            debounce: wikiPageCount > 0,
            reason:
              wikiPageCount === 0
                ? "initial wiki build"
                : "source files changed",
          })
        : false;

      return {
        ok: true,
        data: {
          files: files.length,
          changed,
          queued_regeneration: queuedRegeneration,
        },
      };
    } catch (e) {
      log.error("Sources endpoint error", { error: (e as Error).message });
      return { ok: false, error: "internal_error" };
    }
  })

  // --- Search ---

  .get("/search/:wiki", async ({ params, query, headers }) => {
    const { db } = authGuard(headers);
    const q = query.q as string;
    if (!q)
      return { ok: false, error: "missing_query", message: "?q= is required" };

    const wiki = db
      .prepare("SELECT id FROM wikis WHERE name = ?")
      .get(params.wiki) as { id: number } | null;
    if (!wiki) return { ok: false, error: "wiki_not_found" };

    const limit = Number(query.limit) || undefined;

    const results = await search(db, wiki.id, q, { limit });

    return { ok: true, data: { results } };
  })

  // --- Wiki management ---

  .get("/wikis", ({ headers }) => {
    const { db } = authGuard(headers);
    const wikis = db
      .prepare(
        "SELECT id, name, visibility, created_at FROM wikis ORDER BY name",
      )
      .all();
    return { ok: true, data: { wikis } };
  })

  .delete("/wikis/:name", ({ params, headers }) => {
    const { db } = authGuard(headers);
    const wiki = db
      .prepare("SELECT id FROM wikis WHERE name = ?")
      .get(params.name) as { id: number } | null;
    if (!wiki) return { ok: false, error: "wiki_not_found" };

    // Cascade delete
    db.prepare("DELETE FROM wiki_chunks WHERE wiki_id = ?").run(wiki.id);
    db.prepare("DELETE FROM source_files WHERE wiki_id = ?").run(wiki.id);
    db.prepare("DELETE FROM wiki_files WHERE wiki_id = ?").run(wiki.id);
    db.prepare("DELETE FROM events WHERE wiki_id = ?").run(wiki.id);
    db.prepare("DELETE FROM wikis WHERE id = ?").run(wiki.id);

    return { ok: true };
  })

  // Delete individual wiki page and its chunks, then trigger index rebuild
  .delete("/wikis/:name/pages/:path", async ({ params, headers }) => {
    const { db } = authGuard(headers);
    const wiki = db
      .prepare("SELECT id FROM wikis WHERE name = ?")
      .get(params.name) as { id: number } | null;

    if (!wiki) return { ok: false, error: "wiki_not_found" };

    let pagePath = params.path;
    if (!pagePath.endsWith(".md")) pagePath += ".md";

    // Mark as deleted instead of removing the record (so we remember not to regenerate it)
    db.prepare(
      "UPDATE wiki_files SET deleted = TRUE WHERE wiki_id = ? AND path = ?",
    ).run(wiki.id, pagePath);
    db.prepare("DELETE FROM wiki_chunks WHERE wiki_id = ? AND path = ?").run(
      wiki.id,
      pagePath,
    );

    // Trigger index regeneration (will rebuild index.md without this page)
    import("../lib/agent").then(({ runAgent }) => {
      runAgent(
        db,
        wiki.id,
        { name: params.name },
        { reason: `deleted page: ${pagePath}` },
      ).catch((e) => {
        import("../lib/log").then(({ log }) => {
          log.error(`Index rebuild after deletion failed`, {
            wiki: params.name,
            page: pagePath,
            error: (e as Error).message,
          });
        });
      });
    });

    return { ok: true, data: { deleted: pagePath } };
  })

  // --- Usage ---

  .get("/usage", ({ headers }) => {
    const { db } = authGuard(headers);

    const period = new Date();
    period.setDate(1);
    const periodStart = period.toISOString().slice(0, 10);

    const events = db
      .prepare(`
      SELECT type, SUM(count) as total
      FROM events
      WHERE created_at >= ?
      GROUP BY type
    `)
      .all(periodStart) as { type: string; total: number }[];

    const wikiCount = (
      db.prepare("SELECT COUNT(*) as count FROM wikis").get() as {
        count: number;
      }
    ).count;

    const usage: Record<string, number> = {};
    for (const e of events) usage[e.type] = e.total;

    return {
      ok: true,
      data: {
        period: period.toISOString().slice(0, 7),
        wikis: wikiCount,
        source_pushes: usage.source_push || 0,
        wiki_updates: usage.wiki_update || 0,
        credits_used: usage.credits_used || 0,
      },
    };
  })

  // --- Rebuild ---

  .post("/rebuild", async ({ body, headers }) => {
    const { user, db } = authGuard(headers);
    const b = asObject(body);
    const wikiName = requireString(b, "wiki");
    const force = Boolean(b.force);

    const wiki = db
      .prepare("SELECT id FROM wikis WHERE name = ?")
      .get(wikiName) as { id: number } | null;
    if (!wiki) return { ok: false, error: "wiki_not_found" };

    // Run in background — builds can take 15+ minutes
    import("../lib/agent").then(({ runAgent }) => {
      runAgent(
        db,
        wiki.id,
        { name: wikiName, legendumToken: user.legendum_token },
        {
          reason: "manual rebuild",
          force: !!force,
        },
      ).catch((e) => {
        import("../lib/log").then(({ log }) => {
          log.error(`Rebuild failed for ${wikiName}`, {
            wiki: wikiName,
            error: (e as Error).message,
          });
        });
      });
    });

    return { ok: true, data: { message: "Rebuild started" } };
  })

  // --- Login (register account key) ---

  .post("/login", async ({ body }) => {
    // Self-hosted mode: there is no Legendum to validate against, and the
    // local user owns everything regardless of what key was sent.
    if (isSelfHosted()) {
      ensureLocalUser();
      return { ok: true, data: { email: LOCAL_USER_EMAIL } };
    }

    const b = asObject(body);
    const key = requireString(b, "key");
    if (!key.startsWith("lak_")) {
      return {
        ok: false,
        error: "invalid_key",
        message: "Key must start with lak_",
      };
    }

    // Already registered?
    const existing = validateAccountKey(key);
    if (existing) {
      return { ok: true, data: { email: existing.email } };
    }

    // Validate against Legendum
    const mod = await import("../lib/legendum.js");
    const legendum = mod.default || mod;
    try {
      const acct = legendum.account(key);
      const whoami = await acct.whoami();
      const email = whoami.email;
      if (!email) {
        return {
          ok: false,
          error: "invalid_key",
          message: "Could not verify account key",
        };
      }

      // Find or create user
      let user = getUserByEmail(email);
      if (!user) {
        const userId = createUser(email);
        user = {
          id: userId,
          email,
          legendum_token: null,
          db_path: `data/user${userId}.db`,
          created_at: "",
        };
      }

      // Store key hash
      storeAccountKey(user.id, key);

      return { ok: true, data: { email } };
    } catch (e) {
      return { ok: false, error: "invalid_key", message: (e as Error).message };
    }
  })

  // --- MCP server ---

  .post("/mcp", async ({ body, headers }) => {
    // MCP supports both authenticated (user wikis) and public wikis.
    // In self-hosted mode the local user db is the only "authenticated" db.
    let db: Database;
    if (isSelfHosted()) {
      ensureLocalUser();
      db = getUserDb(LOCAL_USER_ID);
    } else {
      const token = extractBearerToken(headers.authorization);
      if (token) {
        const user = validateAccountKey(token);
        if (user) {
          db = getUserDb(user.id);
        }
      }
    }
    // Fall back to public DB
    if (!db) db = getPublicDb();

    const result = await handleMcpRequest(db, body as Record<string, unknown>);
    return result;
  });
