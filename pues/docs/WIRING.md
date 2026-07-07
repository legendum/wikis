# Wiring a service — assembling the parts

The per-part docs (`<PART>.md`) each describe one part in isolation. This is the
**assembled view**: how the parts compose into a running service — one
`server.ts`, one `config/pues.yaml`, the env you set, and the routes you end up
serving. Take what your app uses and drop the rest; every piece here is optional
except `core`.

## `config/pues.yaml` — the whole file
One file selects the parts and configures them. Each `<key>:` block is owned by
the like-named part (see that part's doc for the full key set):

```yaml
# Which parts to vendor (drives `bun run pues`). See VENDOR.md.
pues:
  - core          # always
  - vendor        # the Legendum SDK (billing/auth pull it transitively)
  - db
  - auth
  - objects
  - sse
  - style
  - pwa
  - health

core:
  name: my-app                     # app slug; also the default DB/PWA name

db:
  path: data/my-app.db             # optional — this is the default

objects:
  resources:
    fifos:
      table: fifos                 # role→column mapping resolved from the schema
      filter: { equals: [status] }
    items:
      table: items
      parent: { column: fifo_id, table: fifos }
      prefix: /api/fifos/:fifo_ulid

style:
  dark:  { bg_page: "#0b0b0c" }    # sparse token overrides
  light: { bg_page: "#ffffff" }

pwa:
  name: My App

health:
  extra: { region: eu }
```

Parts that read config but need no keys (`a11y`, `forms`, `markdown`, `theme`,
`cli`, `test`) appear only in the `pues:` list. `ai`, `agent`, `billing`,
`email`, `cap`, `meta` add their own blocks (or a separate `config/meta.yaml`)
— see their docs.

## The database schema
`db` applies **`config/schema.sql`** on the first `getDb()` (idempotent — keep
every statement `CREATE TABLE IF NOT EXISTS …`), then any
**`config/migrations/*.sql`** in lexicographic order (`001_…`, `002_…`), tracked
in a `migrations` table. Two tables you'll typically define:

```sql
-- config/schema.sql
CREATE TABLE IF NOT EXISTS users (       -- required by `auth` (canonical shape)
  id             INTEGER PRIMARY KEY,
  email          TEXT NOT NULL UNIQUE,
  legendum_token TEXT,
  meta           TEXT                    -- JSON object
);

CREATE TABLE IF NOT EXISTS fifos (       -- an `objects` resource
  id        INTEGER PRIMARY KEY,
  ulid      TEXT NOT NULL UNIQUE,        -- public_id role
  user_id   INTEGER NOT NULL,            -- owner role
  name      TEXT NOT NULL,               -- label role
  position  INTEGER NOT NULL,
  status    TEXT
);
```

## `server.ts` — wire it together
Each part hands you a route map (or a `broadcast` / `fetch`); you spread them
into one `Bun.serve`. `resolveUser` from `auth` is the thread that ties auth →
SSE → resources together.

```ts
import { getAuthUserId, configureAuth, mountAuthRoutes, mountLegendum,
         mountUserSettings } from "pues/base/auth/server";
import { getDb } from "pues/base/db/server";
import { loadPuesConfig, mountResource } from "pues/base/objects/server";
import { sseRoute } from "pues/base/sse";
import { mountHealthRoutes } from "pues/base/health/server";
import { mountPwaRoutes } from "pues/base/pwa/server";
import { mountWebhooks } from "pues/base/webhooks/server";

const cfg = await loadPuesConfig();
configureAuth({ getDb });                 // wires the canonical users storage
const resolveUser = getAuthUserId;        // (req) => userId | null

const { routes: sseRoutes, broadcast } = sseRoute({ resolveUser });
const pwa = await mountPwaRoutes();

const resources = {
  ...mountResource({ db: getDb, name: "fifos",
                     config: cfg.objects!.resources!.fifos, resolveUser, broadcast }),
};

Bun.serve({
  routes: {
    ...mountAuthRoutes(), ...mountLegendum(), ...mountUserSettings(),
    ...sseRoutes,
    ...resources,
    ...mountHealthRoutes().routes,
    ...pwa.routes,
  },
  async fetch(req) {
    const url = new URL(req.url);
    const hook = await mountWebhooks(req, url.pathname, req.method);
    if (hook) return hook;
    const pwaHit = await pwa.fetch(req);
    if (pwaHit) return pwaHit;
    return new Response("Not Found", { status: 404 });
  },
});
```

## Build step
Two parts emit static assets at build time (a `scripts/build.ts`), served from
`public/dist/`:

```ts
import { buildStyle } from "pues/base/style";
import { buildPwa } from "pues/base/pwa/server";

buildStyle();                                    // → public/dist/pues.css
await buildPwa({ additionalAssets: [
  { url: "/dist/pues.css", path: "public/dist/pues.css" },
]});                                             // → manifest + public/dist/sw.js
```

## Client entry
```tsx
import { Pues } from "pues/base/core";
import { useUser } from "pues/base/auth";
import { registerServiceWorker } from "pues/base/pwa";

function App() {
  const user = useUser();                        // tri-state
  return <Pues fetch={authedFetch} user={user}>{/* screens */}</Pues>;
}
registerServiceWorker();
```

## Environment variables
Framework-owned config is `PUES_`-prefixed; third-party integrations keep their
vendor names. Set per deployment (only for the parts you use):

| Var | Part | Purpose |
| --- | --- | --- |
| `PUES_COOKIE_SECRET` | auth | session-cookie HMAC (required, hosted) |
| `PUES_DOMAIN` | auth | public origin (required, hosted) |
| `PUES_LINK_KEY_MAX_AGE_SECONDS` | auth | link-key reuse window (default 14d) |
| `PUES_DB_PATH` | db | override the yaml `db.path` (tests/dev) |
| `PUES_CAP_PRIVATE_KEY[_FILE]` / `PUES_CAP_PUBLIC_KEY[_FILE]` | cap | signing / verifying keys |
| `PUES_CAP_TTL_SECONDS` | cap | default token lifetime (default 3600) |
| `PUES_WEBHOOKS_<NAME>_SECRET` / `PUES_WEBHOOKS_SECRET` | webhooks | inbound auth |
| `PUES_<PROVIDER>_BASE_URL` | ai | override a provider base URL |
| `GEMINI_API_KEY` / `OPENAI_API_KEY` / `XAI_API_KEY` / `CLAUDE_API_KEY` | ai | provider keys |
| `SMTP_HOST` / `SMTP_USER` / `SMTP_PASS` / `SMTP_PORT` / `SMTP_SECURE` / `EMAIL_FROM` | email | SMTP transport |
| `LEGENDUM_API_KEY` / `LEGENDUM_SECRET` | vendor | hosted billing (Legendum SDK) |

## Routes you end up serving
A fully-wired app exposes (paths are pues conventions, not configurable):

| Route | Part |
| --- | --- |
| `GET /api/health` (or `/internal/health`) | health |
| `GET /api/events` (SSE) | sse |
| `/pues/auth/*`, `/pues/legendum/*`, user-settings | auth |
| `GET/POST /api/<resource>`, `PATCH/DELETE /api/<resource>/:id`, `GET …/counts` | objects |
| `/manifest.json`, `/dist/sw.js`, icons, `/dist/workbox-*.js` | pwa |
| `POST /webhooks/<name>` | webhooks |
| `GET /llms.txt`, `robots.txt` / `sitemap.xml` renderers | meta |

## Notes
`core` is always vendored; every other part is opt-in via the `pues:` list.
Order in `server.ts` is only significant for the `fetch` fall-through
(`mountWebhooks` and `pwa.fetch` run after literal `routes` miss). The single
thread through the whole graph is `resolveUser` — the same function authorizes
SSE streams and resource writes, so one user's data can never reach another's.
