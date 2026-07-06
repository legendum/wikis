/**
 * 401-handling registry + fetch wrapper.
 *
 * `<Pues>` (see Pues.tsx) automatically wraps whatever fetch the
 * consumer supplies (or `globalThis.fetch` if none) with
 * `wrapFetchWithUnauthorized` so every pues-resolved fetch fires an
 * internal "unauthorized" event on a 401 response.
 *
 * `useUser` (in `base/auth/`) subscribes to that event via
 * `onPuesUnauthorized` on mount and flips the user back to `null`
 * when the server starts returning 401 mid-session. Consumers do not
 * call either function directly — the behavior is the framework
 * default.
 *
 * Lives in `base/core/` (not `base/auth/`) because `<Pues>` lives here
 * and must not import from a feature part. The "401 = unauthorized"
 * concept is generic-enough HTTP semantics that it belongs in the
 * bord regardless.
 *
 * Exemptions:
 *   - Cross-origin requests (a 401 from a third-party API does not
 *     mean "log the user out of this app").
 *   - Requests to `/pues/auth/*` (the OAuth flow itself; a 401 during
 *     login should not bounce the user back to the login screen
 *     mid-flow).
 */

const PUES_AUTH_PREFIX = "/pues/auth/";

let unauthorizedHandler: (() => void) | null = null;

/**
 * Subscribe to 401 events from any fetch resolved through `<Pues>`.
 * Returns an unsubscribe function. Single-slot semantics (last
 * subscriber wins) — `useUser` is the only intended subscriber, and
 * there is only ever one `useUser` instance per app.
 */
export function onPuesUnauthorized(cb: () => void): () => void {
  unauthorizedHandler = cb;
  return () => {
    if (unauthorizedHandler === cb) unauthorizedHandler = null;
  };
}

function resolveRequestUrl(input: RequestInfo | URL): URL | null {
  if (typeof window === "undefined") return null;
  try {
    if (typeof input === "string") {
      return new URL(input, window.location.origin);
    }
    if (input instanceof URL) return input;
    if (input instanceof Request) {
      return new URL(input.url, window.location.origin);
    }
  } catch {
    return null;
  }
  return null;
}

function shouldFireUnauthorized(url: URL | null): boolean {
  if (typeof window === "undefined") return true;
  if (!url) return true;
  if (url.origin !== window.location.origin) return false;
  if (url.pathname.startsWith(PUES_AUTH_PREFIX)) return false;
  return true;
}

/**
 * Wrap a base `fetch` with 401-handling. Called internally by `<Pues>`;
 * not exported from any public barrel. On a 401 response: if the
 * request was same-origin and not under `/pues/auth/`, fires the
 * registered unauthorized handler (if any) after the response
 * resolves. The response itself is always returned to the caller
 * unchanged.
 */
export function wrapFetchWithUnauthorized(
  baseFetch: typeof fetch,
): typeof fetch {
  const wrapped = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const response = await baseFetch(input, init);
    if (response.status === 401 && unauthorizedHandler) {
      const url = resolveRequestUrl(input);
      if (shouldFireUnauthorized(url)) unauthorizedHandler();
    }
    return response;
  };
  return wrapped as typeof fetch;
}
