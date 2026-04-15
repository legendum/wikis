# Authentication

## Overview

The "wikis" project secures access to user-specific wikis and protected APIs through Bearer token authentication using account keys (`lak_...`) or cookie-based sessions. Protected endpoints include syncing sources (`POST /api/sources`), pushing wiki files (`POST /api/push`), pulling files (`POST /api/pull`), searching private wikis (`GET /api/search/:wiki`), listing wikis (`GET /api/wikis`), and regenerating content (`POST /api/rebuild`). Public endpoints such as static assets (`/public/*`), health checks (`/health`), and the MCP server (`POST /mcp`) require no authentication and default to the public database (`data/public.db`).

Authentication integrates with Legendum for identity and billing verification in hosted mode. The system supports account keys for CLI, API, and agent access, and OAuth-based sessions for web browsers. Credentials reside in a global SQLite database (`data/wikis.db`), while per-user data isolates in `data/user{id}.db` databases, referenced by user IDs from the global database ([database-storage.md](database-storage.md)). Legendum manages external identity and billing; the project handles local validation, account key hashing, and session management.

Self-hosting employs the same mechanisms but bypasses Legendum validation and billing if `LEGENDUM_API_KEY` and `LEGENDUM_SECRET` are absent, defaulting to a single local user ([self-hosting.md](self-hosting.md)).

## Key Concepts

The project uses three authentication mechanisms:

- **Account keys** (`lak_...`): Long-lived tokens for CLI ([cli-commands.md](cli-commands.md)), API ([api-reference.md](api-reference.md)), and agent access. Hashed and stored in the global database for local validation.
- **OAuth sessions**: Short-lived, httpOnly cookies issued via Legendum OAuth for web access, stored in the `sessions` table.
- **Public fallback**: No credentials needed for public wikis and MCP tools, using `data/public.db`.

User resolution prioritizes Bearer tokens for APIs, then session cookies, then account key cookies for web routes. Self-hosted mode treats all requests as the local user without checks.

## Account Keys

Account keys enable secure token-based access. Users generate keys via Legendum and register them through `POST /api/login`.

```typescript
// src/routes/api.ts — /api/login endpoint
.post("/login", async ({ body }) => {
  // Self-hosted mode: no Legendum validation, local user owns everything.
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
```

Keys hash via SHA-256 and store in the `account_keys` table with the user ID:

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

API middleware validates Bearer tokens:

```typescript
// src/routes/api.ts — authGuard
function authGuard(headers: Record<string, string | undefined>) {
  // Self-hosted mode: no auth, single local user.
  if (isSelfHosted()) {
    ensureLocalUser();
    return {
      user: {
        id: LOCAL_USER_ID,
        email: LOCAL_USER_EMAIL,
        legendum_token: null,
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
```

## Web Sessions (OAuth)

Web access relies on cookie-based sessions via Legendum OAuth. The `/login` route redirects to Legendum; `/auth/callback` exchanges the code, creates a session, and sets a cookie.

```typescript
// src/routes/auth.ts — /login and /auth/callback
.get("/login", async ({ cookie: { wikis_state }, redirect, set }) => {
  const client = getClient();
  if (!client) {
    set.status = 404;
    return "Login with Legendum is not configured on this server.";
  }

  const state = crypto.randomUUID();
  wikis_state.value = state;
  wikis_state.httpOnly = true;
  wikis_state.sameSite = "lax";
  wikis_state.maxAge = STATE_MAX_AGE;

  saveState(state);

  const linkData = await client.requestLink();
  const url = client.authAndLinkUrl({
    redirectUri: `${BASE_URL}/auth/callback`,
    state,
    linkCode: linkData.code,
  });

  return redirect(url);
})

.get("/auth/callback", async ({
  query,
  cookie: { wikis_session, wikis_state },
  redirect,
  set,
}) => {
  const { code, state } = query;

  if (!code || !state) {
    set.status = 400;
    return "Missing code or state";
  }

  if (!validateState(state, wikis_state.value as string | undefined)) {
    set.status = 403;
    return "Invalid state parameter";
  }
  wikis_state.remove();

  const client = getClient();
  if (!client) {
    set.status = 500;
    return "Legendum not configured";
  }

  let exchanged = await client.exchangeCode(code, `${BASE_URL}/auth/callback`);
  const { email } = exchanged;
  if (!email) {
    set.status = 502;
    return "Could not read email from Legendum";
  }

  let userId = getUserByEmail(email)?.id ?? createUser(email);

  const serviceToken = exchanged.account_token;
  if (serviceToken) {
    getGlobalDb().prepare("UPDATE users SET legendum_token = ? WHERE id = ?").run(serviceToken, userId);
  }

  const sessionToken = createSession(userId);
  wikis_session.value = sessionToken;
  wikis_session.httpOnly = true;
  wikis_session.sameSite = "lax";
  wikis_session.maxAge = SESSION_MAX_AGE;
  wikis_session.path = "/";

  return redirect("/");
});
```

Sessions store in the global database:

```typescript
// src/routes/auth.ts
export function getSessionUser(token: string): number | null {
  const row = getGlobalDb()
    .prepare("SELECT user_id FROM sessions WHERE token = ?")
    .get(token) as { user_id: number } | null;
  return row?.user_id ?? null;
}
```

Web routes resolve users from headers and cookies:

```typescript
// src/routes/web.ts — resolveUser
function resolveUser(headers: Record<string, string | undefined>): { id: number } | null {
  // Self-hosted: every visitor is the local user.
  if (isSelfHosted()) {
    ensureLocalUser();
    return { id: LOCAL_USER_ID };
  }

  const cookie = headers.cookie;
  const bearerToken = extractBearerToken(headers.authorization);
  if (bearerToken) return validateAccountKey(bearerToken);

  if (!cookie) return null;

  const sessionMatch = cookie.match(/wikis_session=([^;]+)/);
  if (sessionMatch) {
    const userId = getSessionUser(sessionMatch[1]);
    if (userId) return { id: userId };
  }

  const tokenMatch = cookie.match(/wikis_token=([^;]+)/);
  if (tokenMatch) return validateAccountKey(tokenMatch[1]);

  return null;
}
```

Logout deletes the session via `POST /auth/logout`.

## Public Access and Fallback

Public wikis reside in `data/public.db`. Web routes query the user database first, then public. The MCP endpoint (`POST /mcp`) uses an authenticated database if a token provides one, otherwise public:

```typescript
// src/routes/api.ts — /mcp
.post("/mcp", async ({ body, headers }) => {
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
  if (!db) db = getPublicDb();

  const result = await handleMcpRequest(db, body as Record<string, unknown>);
  return result;
});
```

Details appear in [mcp-integration.md](mcp-integration.md).

## Self-Hosting Considerations

Self-hosted mode (`wikis serve`) activates without Legendum credentials. The `authGuard` and `resolveUser` return the local user (`id: 0`, `LOCAL_USER_EMAIL: "local@example.com"`) for all requests, bypassing token checks. Account keys validate locally via hashing without external calls. OAuth skips if unconfigured. Users supply LLM keys directly ([configuration.md](configuration.md)), avoiding billing ([self-hosting.md](self-hosting.md)).