import { Elysia, t } from "elysia";
import { extractBearerToken, validateAccountKey } from "../lib/auth";
import { getUserDb, getPublicDb } from "../lib/db";
import { handleMcpRequest } from "../lib/mcp";
import { search } from "../lib/search";
import { getManifest, upsertFile, getFile, deleteFile, listFiles } from "../lib/storage";
import { indexFile, removeFile } from "../lib/indexer";
import { diffManifests, type Manifest } from "../lib/sync";

/**
 * Auth middleware — extracts user from account key.
 */
function authGuard(headers: Record<string, string | undefined>) {
  const token = extractBearerToken(headers.authorization);
  if (!token) throw new Error("Missing Authorization header");

  const user = validateAccountKey(token);
  if (!user) throw new Error("Invalid account key");

  return { user, db: getUserDb(user.id) };
}

export const apiRoutes = new Elysia({ prefix: "/api" })

  // --- Sync ---

  .post("/sync", async ({ body, headers }) => {
    const { user, db } = authGuard(headers);
    const { wiki: wikiName, files: localManifest } = body as {
      wiki: string;
      files: Manifest;
    };

    // Get or create wiki
    let wiki = db.prepare("SELECT id FROM wikis WHERE name = ?").get(wikiName) as { id: number } | null;
    if (!wiki) {
      db.prepare("INSERT INTO wikis (name) VALUES (?)").run(wikiName);
      wiki = db.prepare("SELECT id FROM wikis WHERE name = ?").get(wikiName) as { id: number };
    }

    const remoteManifest = getManifest(db, wiki.id);
    const plan = diffManifests(localManifest, remoteManifest);

    return { ok: true, data: plan };
  })

  .post("/push", async ({ body, headers }) => {
    const { user, db } = authGuard(headers);
    const { wiki: wikiName, files } = body as {
      wiki: string;
      files: { path: string; content: string; modified: string }[];
    };

    const wiki = db.prepare("SELECT id FROM wikis WHERE name = ?").get(wikiName) as { id: number } | null;
    if (!wiki) return { ok: false, error: "wiki_not_found" };

    for (const file of files) {
      upsertFile(db, wiki.id, file.path, file.content, file.modified);
      // Index wiki content for search
      await indexFile(db, wiki.id, "wiki_chunks", file.path, file.content, { embeddings: false });
    }

    return { ok: true, data: { pushed: files.length } };
  })

  .post("/pull", async ({ body, headers }) => {
    const { user, db } = authGuard(headers);
    const { wiki: wikiName, paths } = body as {
      wiki: string;
      paths: string[];
    };

    const wiki = db.prepare("SELECT id FROM wikis WHERE name = ?").get(wikiName) as { id: number } | null;
    if (!wiki) return { ok: false, error: "wiki_not_found" };

    const files = paths
      .map((p) => getFile(db, wiki.id, p))
      .filter(Boolean)
      .map((f) => ({
        path: f!.path,
        content: f!.content,
        hash: f!.hash,
        modified: f!.modified_at,
      }));

    return { ok: true, data: { files } };
  })

  // --- Source ingestion ---

  .post("/sources", async ({ body, headers }) => {
    const { user, db } = authGuard(headers);
    const { wiki: wikiName, files } = body as {
      wiki: string;
      files: { path: string; content: string }[];
    };

    const wiki = db.prepare("SELECT id FROM wikis WHERE name = ?").get(wikiName) as { id: number } | null;
    if (!wiki) return { ok: false, error: "wiki_not_found" };

    // Store source files — only update modified_at when content changed
    const { hashContent } = await import("../lib/storage");
    const now = new Date().toISOString();
    let changed = 0;
    for (const file of files) {
      const hash = hashContent(file.content);
      const existing = db.prepare(
        "SELECT hash FROM source_files WHERE wiki_id = ? AND path = ?"
      ).get(wiki.id, file.path) as { hash: string } | null;

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

    // Schedule debounced regeneration if anything changed
    if (changed > 0) {
      const { scheduleRegeneration } = await import("../lib/regenerator");
      const dbPath = `user${user.id}`;
      scheduleRegeneration(dbPath, db, wiki.id, { name: wikiName });
    }

    return { ok: true, data: { files: files.length, changed } };
  })

  // --- Search ---

  .get("/search/:wiki", async ({ params, query, headers }) => {
    const { user, db } = authGuard(headers);
    const q = query.q as string;
    if (!q) return { ok: false, error: "missing_query", message: "?q= is required" };

    const wiki = db.prepare("SELECT id FROM wikis WHERE name = ?").get(params.wiki) as { id: number } | null;
    if (!wiki) return { ok: false, error: "wiki_not_found" };

    const limit = Number(query.limit) || undefined;

    const results = await search(db, wiki.id, q, { limit });

    return { ok: true, data: { results } };
  })

  // --- Wiki management ---

  .get("/wikis", ({ headers }) => {
    const { user, db } = authGuard(headers);
    const wikis = db.prepare("SELECT id, name, visibility, created_at FROM wikis ORDER BY name").all();
    return { ok: true, data: { wikis } };
  })

  .delete("/wikis/:name", ({ params, headers }) => {
    const { user, db } = authGuard(headers);
    const wiki = db.prepare("SELECT id FROM wikis WHERE name = ?").get(params.name) as { id: number } | null;
    if (!wiki) return { ok: false, error: "wiki_not_found" };

    // Cascade delete
    db.prepare("DELETE FROM wiki_chunks WHERE wiki_id = ?").run(wiki.id);
    db.prepare("DELETE FROM source_files WHERE wiki_id = ?").run(wiki.id);
    db.prepare("DELETE FROM wiki_files WHERE wiki_id = ?").run(wiki.id);
    db.prepare("DELETE FROM events WHERE wiki_id = ?").run(wiki.id);
    db.prepare("DELETE FROM wikis WHERE id = ?").run(wiki.id);

    return { ok: true };
  })

  // --- Usage ---

  .get("/usage", ({ headers }) => {
    const { user, db } = authGuard(headers);

    const period = new Date();
    period.setDate(1);
    const periodStart = period.toISOString().slice(0, 10);

    const events = db.prepare(`
      SELECT type, SUM(count) as total
      FROM events
      WHERE created_at >= ?
      GROUP BY type
    `).all(periodStart) as { type: string; total: number }[];

    const wikiCount = (db.prepare("SELECT COUNT(*) as count FROM wikis").get() as { count: number }).count;

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

  // --- MCP server ---

  .post("/mcp", async ({ body, headers }) => {
    // MCP supports both authenticated (user wikis) and public wikis
    const token = extractBearerToken(headers.authorization);
    let db;
    if (token) {
      const user = validateAccountKey(token);
      if (user) {
        db = getUserDb(user.id);
      }
    }
    // Fall back to public DB
    if (!db) db = getPublicDb();

    const result = await handleMcpRequest(db, body as Record<string, unknown>);
    return result;
  });
