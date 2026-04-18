import { existsSync } from "node:fs";
import { Elysia } from "elysia";
import {
  CONTENT_TYPE_MARKDOWN_UTF8,
  CONTENT_TYPE_TEXT_UTF8,
  HOST,
  PORT,
  PUBLIC_DIR,
} from "./lib/constants";
import { createUser, getGlobalDb } from "./lib/db";
import legendum from "./lib/legendum.js";
import { log } from "./lib/log";
import { apiRoutes } from "./routes/api";
import { authRoutes } from "./routes/auth";
import { webRoutes } from "./routes/web";

const LLMS_TXT = `${PUBLIC_DIR}/llms.txt`;

/**
 * Legendum SDK routes under `/legendum` — required for Chats2Me `auth.link`
 * (`POST /legendum/link-key`, Bearer `lak_…` → `{ account_token, email }`).
 */
const legendumMiddleware = legendum.isConfigured()
  ? legendum.middleware({
      prefix: "/legendum",
      getToken: async () => null,
      setToken: async () => {},
      clearToken: async () => {},
      onLinkKey: async (_req, accountToken, email) => {
        if (!email) return;
        const db = getGlobalDb();
        const row = db
          .prepare("SELECT id FROM users WHERE email = ?")
          .get(email) as { id: number } | undefined;
        if (row) {
          db.prepare("UPDATE users SET legendum_token = ? WHERE id = ?").run(
            accountToken,
            row.id,
          );
        } else {
          const uid = createUser(email);
          db.prepare("UPDATE users SET legendum_token = ? WHERE id = ?").run(
            accountToken,
            uid,
          );
        }
      },
    })
  : null;

const app = new Elysia()
  .get("/health", () => ({ ok: true }))
  .get("/llms.txt", ({ set }) => {
    if (!existsSync(LLMS_TXT)) {
      set.status = 404;
      return "Not found";
    }
    return new Response(Bun.file(LLMS_TXT), {
      headers: { "Content-Type": CONTENT_TYPE_TEXT_UTF8 },
    });
  })
  .get("/public/*", ({ params }) => {
    const path = `${PUBLIC_DIR}/${params["*"]}`;
    const file = Bun.file(path);
    const lower = path.toLowerCase();
    if (lower.endsWith(".md")) {
      return new Response(file, {
        headers: { "Content-Type": CONTENT_TYPE_MARKDOWN_UTF8 },
      });
    }
    if (lower.endsWith(".txt")) {
      return new Response(file, {
        headers: { "Content-Type": CONTENT_TYPE_TEXT_UTF8 },
      });
    }
    return file;
  })
  .all("/legendum/*", async ({ request, set }) => {
    if (!legendumMiddleware) {
      set.status = 503;
      return Response.json({
        error: "Legendum service credentials are not configured on this server.",
      });
    }
    const res = await legendumMiddleware(request);
    if (res) return res;
    set.status = 404;
    return Response.json({ error: "NOT_FOUND" });
  })
  .use(apiRoutes)
  .use(authRoutes)
  .use(webRoutes)
  .listen({ port: PORT, hostname: HOST });

log.info(`wikis.fyi running at http://${HOST}:${PORT}`);

export { app };
