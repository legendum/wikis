# Authentication

## Overview

Authentication in the "wikis" project secures access to user-specific wikis and APIs. Operations such as syncing sources (`POST /api/sources`), pushing wiki files (`POST /api/push`), pulling files (`POST /api/pull`), searching private wikis (`GET /api/search/:wiki`), listing wikis (`GET /api/wikis`), and regenerating content (`POST /api/rebuild`) require valid credentials via a Bearer token in the `Authorization` header. Public wikis, static assets (`/public/*`), health checks (`/health`), and MCP endpoints (`POST /mcp`) remain accessible without authentication, falling back to the public database.

The system integrates with Legendum for identity verification. It supports two primary flows: **account keys** (`lak_...`) for CLI and API clients, and **OAuth sessions** for web browsers. Credentials and sessions store in a global SQLite database (`data/wikis.db`), with per-user data isolated in separate databases (`data/user{id}.db`) referenced by user IDs from the global database, as detailed in [database-storage.md](database-storage.md). Legendum handles external identity verification and billing token issuance; the project focuses on secure local validation, hashing of account keys, and session management.

Self-hosting uses the same mechanisms but skips Legendum validation and billing when Legendum credentials (`LEGENDUM_API_KEY`, `LEGENDUM_SECRET`) are absent ([self-hosting.md](self-hosting.md)).

## Key Concepts

The project employs three mechanisms:

- **Account keys** (`lak_...`): Long-lived tokens for CLI, API, and agent access. Stored hashed in the global database for local validation.
- **OAuth sessions**: Short-lived browser cookies issued via Legendum OAuth for web access.
- **Public fallback**: No authentication required for public wikis and MCP tools, using `data/public.db`.

User resolution prioritizes authenticated access: API routes use Bearer tokens exclusively; web routes check Bearer first, then session cookies, then account key cookies.

## Account Keys

Account keys provide secure, token-based access for CLI commands ([cli-commands.md](cli-commands.md)) and API calls ([api-reference.md](api-reference.md)). Users generate a key from Legendum and register it via `POST /api/login`:

```typescript
// src/routes/api.ts — /api/login endpoint
.post("/login", async ({ body }) => {
  const { key } = body as { key: string };
  if (!key?.startsWith("lak_")) {
    return { ok: false, error: "invalid_key" };
  }

  // Already registered?
  const existing = validateAccountKey(key);
  if (existing) return { ok: true, data: { email: existing.email } };

  // Validate against Legendum (hosted mode)
  const mod = await import("../lib/legendum.js");
  const legendum = mod.default || mod;
  const acct = legendum.account(key);
  const whoami = await acct.whoami();
  const email = whoami.email;

  // Find or create user
  let user = getUserByEmail(email);
  if (!user) {
    const userId = createUser(email);
    user = { id: userId, email, legendum_token: null, db_path: `data/user${userId}.db` };
  }

  // Store hashed key
  storeAccountKey(user.id, key);
  return { ok: true, data: { email } };
});
```

Keys hash with SHA-256 and store in `account_keys` table alongside the user ID:

```typescript
// src/lib/auth.ts
export function validateAccountKey(key: string): AccountKeyUser | null {
  if (!key?.startsWith("lak_")) return null;
  const hash = createHash("sha256").update(key).digest("hex");
  const db = getGlobalDb();
  const row = db.prepare(`
    SELECT u.id, u.email, u.legendum_token
    FROM users u JOIN account_keys ak ON ak.user_id = u.id
    WHERE ak.key_hash = ?
  `).get(hash) as AccountKeyUser | null;
  return row;
}

export function storeAccountKey(userId: number, key: string): void {
  const hash = createHash("sha256").update(key).digest("hex");
  const prefix = key.slice(0, 12);
  getGlobalDb().prepare(`
    INSERT INTO account_keys (user_id, key_hash, key_prefix, label)
    VALUES (?, ?, ?, ?)
  `).run(userId, hash, prefix, "default");
}
```

API middleware extracts and validates Bearer tokens:

```typescript
// src/routes/api.ts — authGuard
function authGuard(headers: Record<string, string | undefined>) {
  const token = extractBearerToken(headers.authorization);
  if (!token) throw new Error("Missing Authorization header");
  const user = validateAccountKey(token);
  if (!user) throw new Error("Invalid account key");
  return { user, db: getUserDb(user.id) };
}

export function extractBearerToken(header: string | null | undefined): string | null {
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}
```

## Web Sessions (OAuth)

Web access uses cookie-based sessions via Legendum OAuth. The `/login` route redirects to Legendum; `/auth/callback` exchanges the code and issues a session cookie:

```typescript
// src/routes/auth.ts
.get("/login", async ({ cookie: { wikis_state }, redirect }) => {
  const client = getClient(); // Legendum client if hosted
  const state = crypto.randomUUID();
  wikis_state.value = state; // Anti-CSRF state
  const linkData = await client.requestLink();
  const url = client.authAndLinkUrl({ redirectUri: `${BASE_URL}/auth/callback`, state, linkCode: linkData.code });
  return redirect(url);
})

.get("/auth/callback", async ({ query, cookie: { wikis_session, wikis_state } }) => {
  const { code, state } = query;
  if (!validateState(state, wikis_state.value as string)) return "Invalid state";

  const exchanged = await client.exchangeCode(code, `${BASE_URL}/auth/callback`);
  const email = exchanged.email;
  let userId = getUserByEmail(email)?.id ?? createUser(email);

  // Store billing token if present
  const serviceToken = exchanged.account_token ?? exchanged.legendum_token;
  if (serviceToken) {
    getGlobalDb().prepare("UPDATE users SET legendum_token = ? WHERE id = ?").run(serviceToken, userId);
  }

  // Create session cookie
  const sessionToken = createSession(userId); // Inserts into sessions table
  wikis_session.value = sessionToken;
  wikis_session.httpOnly = true;
  wikis_session.maxAge = SESSION_MAX_AGE; // 30 days
  return redirect("/");
});

export function getSessionUser(token: string): number | null {
  return getGlobalDb().prepare("SELECT user_id FROM sessions WHERE token = ?").get(token)?.user_id ?? null;
}
```

Web routes resolve users via cookies or tokens:

```typescript
// src/routes/web.ts
function resolveUser(headers: Record<string, string | undefined>): { id: number } | null {
  const bearerToken = extractBearerToken(headers.authorization);
  if (bearerToken) return validateAccountKey(bearerToken);

  const cookie = headers.cookie;
  const sessionMatch = cookie?.match(/wikis_session=([^;]+)/);
  if (sessionMatch) return { id: getSessionUser(sessionMatch[1]) ?? 0 };

  const tokenMatch = cookie?.match(/wikis_token=([^;]+)/);
  if (tokenMatch) return validateAccountKey(tokenMatch[1]);

  return null;
}
```

Logout deletes the session: `POST /auth/logout`.

## Public Access and Fallback

Public wikis store in `data/public.db`. Web routes check user DB first, then public DB. MCP (`POST /mcp`) uses authenticated DB if token provided, else public DB:

```typescript
// src/routes/api.ts — /mcp
.post("/mcp", async ({ body, headers }) => {
  const token = extractBearerToken(headers.authorization);
  let db: Database;
  if (token) {
    const user = validateAccountKey(token);
    if (user) db = getUserDb(user.id);
  }
  if (!db) db = getPublicDb();
  return await handleMcpRequest(db, body as Record<string, unknown>);
});
```

See [mcp-integration.md](mcp-integration.md) for MCP tools.

## Self-Hosting Considerations

In self-hosted mode (`wikis serve`), Legendum integration is optional. Account keys validate locally without external calls if no `LEGENDUM_API_KEY`. OAuth skips if unconfigured. Users provide LLM keys directly ([configuration.md](configuration.md)), bypassing billing ([self-hosting.md](self-hosting.md)).