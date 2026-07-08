---
name: pues-service-bootstrap
description: Bootstrap a consumer repo to use vendored Pues parts with scripts/pues.ts, config/pues.yaml, and correct path mapping. Use when creating a new Pues-backed service or adding Pues to an existing app.
---
# Pues Service Bootstrap

## Goal
Set up a consumer repo so `bun run pues` vendors parts from sibling `../pues` into committed `pues/` and `types/pues/`.

## Reference: the vendored docs
`bun run pues` also vendors **`pues/docs/`** — the consumer-facing contract for
every part you selected: one `pues/docs/<PART>.md` (what it provides, its
`config/pues.yaml` keys, what it serves, how to wire it), plus
**`pues/docs/WIRING.md`** (the assembled-service view: a full `server.ts`,
composite `config/pues.yaml`, `schema.sql`, env vars, and the routes you end up
serving) and `pues/docs/README.md`. Read the relevant `<PART>.md` before wiring a
part, and WIRING.md when composing them — an agent or human can use a part from
its doc alone.

## Workflow
1. Confirm topology:
   - Consumer repo and framework repo are siblings.
   - Framework path from consumer should be `../pues`.

2. Generate bootstrap files from the framework repo:
   - Run `bun run scripts/repo.ts <consumer-repo-name>` from `../pues`.
   - This writes `scripts/pues.ts`, ensures `config/pues.yaml`, and adds `package.json` script `pues`.

3. Set `config/pues.yaml` parts:
   - Add only what the consumer needs under `pues:`.
   - Dependencies are auto-pulled from `PUES_MANIFEST` when vendoring.

4. Add DB schema baseline when app is SQLite-backed:
   - Add `config/schema.sql` as the **base** SQL shape for control + tenant DBs.
   - Evolve shipped tables via numbered files in `config/migrations/` — see
     [[../pues-db-migrations/SKILL.md|pues-db-migrations]] (migrations are additive; never duplicate them in
     `schema.sql`).

5. Add TS path mapping in consumer `tsconfig.json`:
   - Ensure root `tsconfig.json` exists before typecheck runs.
   - `baseUrl: "."`
   - `paths: { "pues/*": ["types/pues/*", "pues/*"] }`

6. Vendor parts:
   - Run `bun run pues` in the consumer repo.
   - Commit `pues/`, `types/pues/` (if present), and `tsconfig.typecheck.json` (if copied).

7. Verify:
   - Run `bun install` if toolchain/type deps are missing.
   - `bun run pues` exits cleanly.
   - `bun run tsc` passes.
   - Imports like `pues/base/auth/server` resolve in typecheck/build.
   - No runtime dependency on live `../pues` (only needed when re-vendoring).

## Bootstrap Sanity Checklist
- [ ] `config/pues.yaml` has required parts for the service.
- [ ] `config/schema.sql` exists for SQLite services and matches the spec.
- [ ] Root `tsconfig.json` exists and includes `baseUrl` + `pues/*` paths.
- [ ] `bun run pues` and `bun run tsc` both pass.
- [ ] If a plan/checklist doc exists (for example `docs/PLAN.md`), mark completed setup items.

## Starter Parts
Use this baseline for a typical Pues PWA service:

```yaml
pues:
  - core
  - theme
  - style
  - db
  - auth
  - objects
  - sse
  - pwa
  - billing

core:
  name: <consumer-name>   # used by puesAppMeta + LoginScreen defaults
```

Trim this list if the consumer does not need all features.

## `puesAppMeta` (auto-generated)
`bun run pues` reads `core.name` from `config/pues.yaml` and emits
`pues/base/core/puesAppMeta.generated.ts` — a browser-safe constant
that other pues primitives (e.g. `<LoginScreen>`) use for defaults.
Commit the generated file along with the other vendored output; do
not edit by hand.

## Common Client Primitives
After bootstrap, prefer these over hand-rolled copies — they exist in
every Pues consumer and were folded after consumers shipped duplicate
implementations:

- `pues/base/core`: `usePageTitle`, `useOnlineStatus`, `puesAppMeta`.
- `pues/base/core` (ULIDs): `ulid()` to mint; `ULID_RE` / `isUlid` /
  `ulidPattern` to match; `ulidToBytes` / `bytesToUlid` for the canonical
  16-byte form (e.g. a SQLite `BLOB(16)`); `ulidTime` to read the embedded
  timestamp. **Do not hand-roll a `lib/ulid.ts`** — id generation and matching
  were folded into core after every consumer shipped a duplicate.
- `pues/base/auth`: `<LoginScreen>` (defaults from `puesAppMeta`).
- `pues/base/objects`: `useSlugRouting`, `useFilterQuery`,
  `useOfflineRowCache` — see [[../pues-objects-resource-setup/SKILL.md|pues-objects-resource-setup]] for the
  list↔detail + offline patterns.

## Schema & migrations

See [[../pues-db-migrations/SKILL.md|pues-db-migrations]]. Short version: migrations are additive to
`schema.sql` on every boot — a column your migration adds must not also appear in
`schema.sql`'s `CREATE TABLE`.

## Rules
- Keep `scripts/pues.ts` constant across consumers.
- Do not gitignore vendored `pues/` or `types/pues/`.
- Add new features by editing `config/pues.yaml` then re-running `bun run pues`.
- Trust dependency closure from `PUES_MANIFEST`; do not hand-copy dependencies.
- Keep `config/schema.sql` as the human-readable **base** schema; evolve shipped
  tables via `config/migrations/NNN_*.sql` only — see [[../pues-db-migrations/SKILL.md|pues-db-migrations]].

## Next
Once parts are vendored, wire them: [[../pues-auth-billing-wiring/SKILL.md|pues-auth-billing-wiring]] for auth/billing
routes, [[../pues-objects-resource-setup/SKILL.md|pues-objects-resource-setup]] for CRUD resources and SSE.
