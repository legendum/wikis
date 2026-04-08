import { Elysia } from "elysia";
import {
  CONTENT_TYPE_MARKDOWN_UTF8,
  CONTENT_TYPE_TEXT_UTF8,
  HOST,
  PORT,
  PUBLIC_DIR,
} from "./lib/constants";
import { log } from "./lib/log";
import { apiRoutes } from "./routes/api";
import { authRoutes } from "./routes/auth";
import { webRoutes } from "./routes/web";

const app = new Elysia()
  .get("/health", () => ({ ok: true }))
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
  .use(apiRoutes)
  .use(authRoutes)
  .use(webRoutes)
  .listen({ port: PORT, hostname: HOST });

log.info(`wikis.fyi running at http://${HOST}:${PORT}`);

export { app };
