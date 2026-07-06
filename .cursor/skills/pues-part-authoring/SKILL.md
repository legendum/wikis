---
name: pues-part-authoring
description: Author or extend a Pues part — add a base/<part> or a new exported component/hook, keeping the barrel, hand-curated .d.ts type surface, manifest deps, and style/defaults.css in sync. Use when developing Pues itself (not when consuming it).
---
# Pues Part Authoring

For working **inside the Pues repo** — adding a new `base/<part>`, or a new
exported symbol to an existing part. (Consuming Pues from an app is
[[../pues-service-bootstrap/SKILL.md|pues-service-bootstrap]]; cutting a version is [[../pues-release/SKILL.md|pues-release]].)

The trap this skill exists to prevent: Pues' consumer type surface lives in
**hand-curated `.d.ts` stubs** under `types/pues/base/<part>/`, *not* generated
from source. The path mapping `pues/*: ["types/pues/*", "pues/*"]` resolves the
`.d.ts` **first**, so a symbol you export from the source barrel but forget to
add to the `.d.ts` is invisible to consumers — their `tsc` fails with
`TS2305: Module '"pues/base/<part>"' has no exported member 'X'`. The source and
the `.d.ts` must move together.

## Adding a new exported component / hook to an existing part
1. Write the source in `base/<part>/`.
2. Export it from the part's **client barrel** `base/<part>/index.ts` (and
   `base/<part>/server.ts` if it touches `node:`/Bun — client-safe default, see
   SPEC §9.6).
3. **Mirror it in the hand-curated type stub** `types/pues/base/<part>/index.d.ts`.
   Match the existing house style — loose is fine and intended: `any` for React
   return types and props you don't need consumers to check; spell out only the
   props that matter (e.g. a string-literal union). Skipping this is the #1
   mistake.
4. If the new code imports *another* part (e.g. a component pulls `Dialog` from
   `../objects`), add that part to this part's `depends` in
   **`base/core/manifest.ts`** — and check you didn't create a cycle.
5. Styling ships through **`base/style/defaults.css`** (`.pues-*` classes,
   compiled into `pues.css` by `buildStyle`). There is no per-part CSS file; add
   classes there.

## Adding a whole new part `base/<name>/`
- All of the above, plus register the part in **`PUES_MANIFEST`**
  (`base/core/manifest.ts`) with its `depends`. Unregistered parts throw at
  vendor time (`resolveDeps`).
- Pick the barrel shape by surface:
  - **Client part** → `index.ts` (the default; `react`/DOM code).
  - **Client + server** → both `index.ts` and `server.ts` (e.g. `base/pwa`).
  - **Server-only** → **`server.ts` only, no `index.ts`** — anything that reads
    disk/env or touches `node:`/Bun (`base/db`, `base/meta`, `base/billing`,
    `base/webhooks`). Its stub is `types/pues/base/<name>/server.d.ts`, and
    consumers import `pues/base/<name>/server`. Don't add an `index.ts` just to
    have one — a server-only part has no client surface.
- Add a `types/pues/base/<name>/` stub (`index.d.ts` and/or `server.d.ts`) if you
  want a curated type surface; if you skip it, consumers resolve the part from
  source via the path mapping (works, but loses the loose-`any` insulation —
  `base/cli`/`base/test` do this).

### Server-only route capabilities (`mount*`)
A capability the host mounts in its request pipeline (`base/webhooks`,
`base/sse`, `base/meta`) exports a **mount/route function**, not React. Two shapes:
- A **route-map factory** returning `{ routes }` to spread into `Bun.serve`
  (`sseRoute`, `mountMeta`, `mountPwaRoutes`).
- A **matcher** `mount*(req, path, method, opts?): Promise<Response | null>` that
  the host calls in its fall-through, returning `null` to defer to normal
  routing (`mountWebhooks`). Use this when the path is dynamic (`/webhooks/<name>`)
  rather than a fixed literal route.

**Env-var convention:** Pues-owned config that the framework itself reads takes
the **`PUES_` prefix** — `PUES_DB_PATH`, `PUES_COOKIE_SECRET`, `PUES_DOMAIN`,
`PUES_WEBHOOKS_<NAME>_SECRET` (or the global `PUES_WEBHOOKS_SECRET` fallback,
which authenticates every webhook name — for one caller fanning a single trust
domain across many event-named hooks). Only third-party integrations keep their vendor
names (`LEGENDUM_*`, `SMTP_*`, provider API keys). A new capability's secrets are
Pues-owned → prefix them `PUES_`.

## Verify before you ship
- **`bun run smoke`** in the Pues repo (lint + test + tsc) — required.
- Then re-vendor a consumer that uses the part (`bun run pues`) and run its
  build + `tsc` — this is what catches a missing `.d.ts` export, since the Pues
  repo's own `tsc` checks source, not the consumer-facing stub.
- Release with [[../pues-release/SKILL.md|pues-release]] when ready (bump, `docs/TAGS.md`, tag).

## Checklist
- [ ] Source written; exported from `index.ts` (and/or `server.ts`). Server-only
      parts have **no `index.ts`** — `server.ts` only.
- [ ] Type stub updated to match the barrel: `index.d.ts` for a client surface,
      `server.d.ts` for a server-only one.
- [ ] New cross-part imports reflected in `manifest.ts` `depends` (no cycle).
- [ ] Styling added to `base/style/defaults.css` (not a per-part file).
- [ ] A mount/route capability exports a route-map factory **or** a
      `mount*(req, path, method, opts?): Promise<Response | null>` matcher.
- [ ] New env vars are `PUES_`-prefixed (framework-owned config convention).
- [ ] `bun run smoke` passes; a re-vendored consumer builds + type-checks.
- [ ] Shipping it? Cut a tag via [[../pues-release/SKILL.md|pues-release]] (bump + `docs/TAGS.md` + `v`-tag).
