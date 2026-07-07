# Pues — read me first

This folder (`pues/docs/`) is the **consumer-facing contract** for the pues
parts vendored into this repo: one `<PART>.md` per part (a flat twin of
`pues/base/`). Each says what the part provides, its `config/pues.yaml` keys,
what it serves, and how to wire it — so an agent or human can *use* a part
from its doc alone.

**Standing up a whole service?** Start with **[WIRING.md](WIRING.md)** — the
assembled view: one `server.ts`, the complete `config/pues.yaml`, the schema,
the env vars, and the routes you end up serving. The per-part docs are the
reference; WIRING.md is the map.

## How pues works in this repo
- **Bun-first.** Pues leans on Bun internals and convention over configuration
  wherever sensible — the smallest thing that works (KISS).
- **Built to the Manifesto.** Every part is designed to the
  [Pues Manifesto](../../.cursor/rules/pues-manifesto.mdc) (BAIT, CEDE, POLS,
  STUF, KISS, DOTE, FIAT, WACO, DAPP, FLOW); when a doc explains *why*, that's
  the source.
- **Backwards-compatible / additive.** Pues evolves additively, so "re-vendor
  the latest pues" is always safe — new parts and exports don't break existing
  consumers. Breaking changes are avoided, not routine.
- **Skills included.** A range of `pues-*` skills ship with pues (under
  `.claude/skills` / `.cursor/skills`) — e.g. `pues-feedback` (feed doc / UX
  improvements back upstream), `pues-part-authoring`, `pues-service-bootstrap`,
  `pues-auth-billing-wiring`.

## Working with the vendored copy
- `pues/base/<part>/` — the code · `types/pues/base/` — the type stubs ·
  `pues/docs/<PART>.md` — these contracts. `config/pues.yaml` selects which
  parts vendor.
- **Never edit the vendored `pues/` tree** — it's a verbatim snapshot,
  overwritten on `bun run pues`. Change pues in the peer `../pues` checkout,
  then re-vendor.

---
*This README is pues-owned and vendored — edit it at `docs/README.md` in
the pues repo, not here.*
