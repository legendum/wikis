/**
 * Auth routes — "Login with Legendum" OAuth flow + cookie sessions.
 */
import { Elysia, t } from "elysia";
import { IS_HOSTED, LEGENDUM_API_KEY, LEGENDUM_SECRET, LEGENDUM_BASE_URL } from "../lib/constants";
import { createUser, getUserByEmail, getGlobalDb } from "../lib/db";
import { storeAccountKey } from "../lib/auth";
import legendum from "../lib/legendum.js";

import { PORT, HOST } from "../lib/constants";
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const SESSION_MAX_AGE = 30 * 24 * 60 * 60; // 30 days
const STATE_MAX_AGE = 10 * 60; // 10 minutes

// In-memory OAuth state store (short-lived)
const oauthStates = new Map<string, number>();

function saveState(state: string) {
  oauthStates.set(state, Date.now());
  // Prune old states
  const cutoff = Date.now() - STATE_MAX_AGE * 1000;
  for (const [k, v] of oauthStates) {
    if (v < cutoff) oauthStates.delete(k);
  }
}

function validateState(state: string, cookieState?: string): boolean {
  // Accept if either server-stored or cookie matches
  if (oauthStates.has(state)) {
    oauthStates.delete(state);
    return true;
  }
  return cookieState === state;
}

function createSession(userId: number): string {
  const token = `wks_${crypto.randomUUID().replace(/-/g, "")}`;
  getGlobalDb().prepare("INSERT INTO sessions (token, user_id) VALUES (?, ?)").run(token, userId);
  return token;
}

export function getSessionUser(token: string): number | null {
  const row = getGlobalDb().prepare("SELECT user_id FROM sessions WHERE token = ?").get(token) as { user_id: number } | null;
  return row?.user_id ?? null;
}

function getClient() {
  if (!IS_HOSTED) return null;
  return legendum.create({
    apiKey: LEGENDUM_API_KEY,
    secret: LEGENDUM_SECRET,
    baseUrl: LEGENDUM_BASE_URL,
  });
}

export const authRoutes = new Elysia()
  /**
   * GET /login — start "Login with Legendum" (login + link in one flow).
   * Redirects browser to Legendum.
   */
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

    // Login + link in one redirect
    const linkData = await client.requestLink();
    const url = client.authAndLinkUrl({
      redirectUri: `${BASE_URL}/auth/callback`,
      state,
      linkCode: linkData.code,
    });

    return redirect(url);
  })

  /**
   * GET /auth/callback — handle redirect back from Legendum.
   */
  .get("/auth/callback", async ({ query, cookie: { wikis_session, wikis_state }, redirect, set }) => {
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

    type ExchangeResult = { email: string; linked?: boolean; account_token?: string; legendum_token?: string; token?: string };
    let exchanged: ExchangeResult;
    try {
      exchanged = await client.exchangeCode(code, `${BASE_URL}/auth/callback`) as ExchangeResult;
    } catch (e) {
      set.status = 401;
      return `Auth failed: ${(e as Error).message}`;
    }

    const { email } = exchanged;
    if (!email) {
      set.status = 502;
      return "Could not read email from Legendum";
    }

    // Find or create user
    let user = getUserByEmail(email);
    let userId: number;
    if (user) {
      userId = user.id;
    } else {
      userId = createUser(email);
    }

    // Store Legendum billing token if present
    const serviceToken = exchanged.account_token ?? exchanged.legendum_token ?? exchanged.token;
    if (serviceToken) {
      getGlobalDb().prepare("UPDATE users SET legendum_token = ? WHERE id = ?").run(serviceToken, userId);
    }

    // Create session cookie
    const sessionToken = createSession(userId);
    wikis_session.value = sessionToken;
    wikis_session.httpOnly = true;
    wikis_session.sameSite = "lax";
    wikis_session.maxAge = SESSION_MAX_AGE;
    wikis_session.path = "/";

    return redirect("/");
  }, {
    query: t.Object({
      code: t.Optional(t.String()),
      state: t.Optional(t.String()),
    }),
  })

  /** POST /auth/logout */
  .post("/auth/logout", ({ cookie: { wikis_session }, redirect }) => {
    const token = wikis_session.value as string | undefined;
    if (token) getGlobalDb().prepare("DELETE FROM sessions WHERE token = ?").run(token);
    wikis_session.remove();
    return redirect("/");
  });
