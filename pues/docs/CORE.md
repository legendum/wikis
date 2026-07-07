# Core — `pues/base/core`

The always-vendored foundation: app identity, the `<Pues>` React provider, ULID
helpers, the 401-aware fetch wrapper, and hosted-vs-self-hosted mode flags. Every
consumer gets `core` first (it carries the manifest that drives vendoring).

## Provides
From `pues/base/core`:
- `usePuesUser`, `usePuesFetch` — read the `<Pues>` context (current user; the
  resolved fetch, per-call override > context > global)
- `defaultRoot` / `defaultCoreName` / `resolveCoreName` — checkout root + app name
- `puesAppMeta` — `{ name }` generated from `config/pues.yaml`
- `ulid`, `isUlid`, `ulidTime`, `ULID_RE`, `ulidToBytes`, … — ULID toolkit
- `puesAuthedFetch` — fetch wrapped with the 401 handler, usable outside React
- `useOnlineStatus`, `usePageTitle`
- mode: `isByLegendum`, `isSelfHosted`, `setByLegendum`, `LOCAL_USER_EMAIL`

## Components
- `Pues` (`PuesProps`, `PuesUser`) — the app-root provider; wrap your app once:
  `<Pues fetch={authedFetch} user={user}>`. `fetch?` is the default fetch for
  every pues hook (auto-wrapped to catch 401s for central logout); `user?` is
  **tri-state** — omit = loading, `null` = anonymous, a `PuesUser`
  (`{ legendum_linked, hosted, meta? }`) = authenticated — read via
  `usePuesUser()`. Own the user with `useUser` from `pues/base/auth`.

## Config
None directly — `resolveCoreName` reads `core.name` from `config/pues.yaml`
(falling back to the checkout folder name).

## Routes / mounts / interfaces
None.

## Consume it
```ts
import { Pues, ulid, puesAuthedFetch } from "pues/base/core";
```

## Notes
Client-safe barrel. The vendoring manifest (`base/core/manifest.ts`,
`resolveDeps`) also lives here — it's tooling metadata, not exported from the
barrel. `ulid` imports pure, so it works before `bun install`.
