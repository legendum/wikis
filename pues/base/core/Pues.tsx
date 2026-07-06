/**
 * `<Pues>` — root provider for app-wide pues configuration.
 *
 * Wrap your app in `<Pues fetch={authedFetch} user={user}>` to supply
 * defaults that every pues hook and component inherits. Per-call options
 * on individual hooks/components — e.g. `useResource(name, { fetch: ... })`
 * — take precedence over the context value, which in turn takes
 * precedence over the global `fetch`.
 *
 * Resolution order, applied by `usePuesFetch`:
 *
 *   options.fetch  >  <Pues fetch={...}>  >  globalThis.fetch
 *
 * `user` is tri-state and read by `usePuesUser()`:
 *
 *   prop omitted (undefined) → loading
 *   user={null}              → anonymous
 *   user={PuesUser}          → authenticated
 *
 * The consumer owns user-state ownership (typically via `useUser` from
 * `pues/base/auth`); `<Pues>` just propagates it to widgets like
 * `<Legendum>` that need to render differently per auth state.
 *
 * Lives in `base/core/` — the *bord* of the smörgåsbord. Other parts
 * (`base/objects/`, `base/theme/`, `base/auth/`, …) depend on `core` to
 * share this app-root context without prop-drilling. A consumer that
 * wants pues at all vendors `core` plus whichever feature parts it uses.
 */

import { createContext, type ReactNode, useContext, useMemo } from "react";
import { wrapFetchWithUnauthorized } from "./unauthorizedHandler";

/**
 * The user shape carried by `<Pues user>` and read by `usePuesUser()`.
 * Fixed (non-generic) at v0.8.0 — byte-identical across consumers today.
 * Widen here if a future Legendum service genuinely needs more.
 *
 * `legendum_linked` — has the user linked their Legendum account
 *   (so billing/charge can run). Anonymous users will not have a
 *   `<Pues user>` value at all; this flag distinguishes authed
 *   "but not yet billing-ready" from authed "fully linked".
 * `hosted` — true in hosted mode (LEGENDUM_API_KEY set on the server);
 *   false in self-hosted mode. Some widgets render differently.
 * `meta.theme` — the server-persisted theme preference, reconciled
 *   into the client by `base/theme/reconcileTheme()` on user fetch.
 */
export type PuesUser = {
  legendum_linked: boolean;
  hosted: boolean;
  meta?: { theme?: unknown };
};

type PuesValue = {
  fetch?: typeof fetch;
  user?: PuesUser | null;
};

const PuesContext = createContext<PuesValue>({});

export type PuesProps = {
  /** Default `fetch` implementation for pues hooks. A consumer-supplied
   * wrapper (e.g. one that catches 401s for centralized logout) can be
   * supplied here once at the root, rather than threaded through every
   * call site. Individual hook options still override. */
  fetch?: typeof fetch;
  /** Current user — tri-state. Omit while still loading; pass `null`
   * for anonymous; pass a `PuesUser` once authenticated. Widgets like
   * `<Legendum>` read this via `usePuesUser()` to switch render
   * branches. */
  user?: PuesUser | null;
  children: ReactNode;
};

export function Pues({ fetch: fetchImpl, user, children }: PuesProps) {
  // Wrap the supplied (or global) fetch with the 401 handler so every
  // pues-resolved fetch participates in the auto-logout-on-session-
  // expiry behavior. `useUser` subscribes via `onPuesUnauthorized` and
  // flips its state to `null` when the handler fires — consumers do
  // not wire either side. Memoized on the input fetch so the resolved
  // identity is stable across re-renders (downstream useMemo /
  // useEffect deps that key on fetch will not invalidate needlessly).
  const wrappedFetch = useMemo(
    () => wrapFetchWithUnauthorized(fetchImpl ?? fetch),
    [fetchImpl],
  );
  const value = useMemo<PuesValue>(
    () => ({ fetch: wrappedFetch, user }),
    [wrappedFetch, user],
  );
  return <PuesContext.Provider value={value}>{children}</PuesContext.Provider>;
}

/** Resolve the fetch implementation for a pues hook/component. Applies
 * the precedence: explicit option > `<Pues>` context > global fetch. */
export function usePuesFetch(override?: typeof fetch): typeof fetch {
  const ctx = useContext(PuesContext);
  return override ?? ctx.fetch ?? fetch;
}

/** Read the current user from `<Pues user={...}>`. Tri-state:
 * `undefined` while loading (prop omitted), `null` if anonymous,
 * `PuesUser` if authenticated. Used internally by `<Legendum>` to
 * branch between the anonymous CTA and the authed credits widget. */
export function usePuesUser(): PuesUser | null | undefined {
  return useContext(PuesContext).user;
}
