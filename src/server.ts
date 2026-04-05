import { Elysia } from "elysia";
import { PORT, HOST, PUBLIC_DIR } from "./lib/constants";
import { apiRoutes } from "./routes/api";
import { authRoutes } from "./routes/auth";
import { webRoutes } from "./routes/web";

const app = new Elysia()
  .get("/health", () => ({ ok: true }))
  .get("/public/*", ({ params }) => Bun.file(`${PUBLIC_DIR}/${params["*"]}`))
  .use(apiRoutes)
  .use(authRoutes)
  .use(webRoutes)
  .listen({ port: PORT, hostname: HOST });

console.log(`wikis.fyi running at http://${HOST}:${PORT}`);

export { app };
