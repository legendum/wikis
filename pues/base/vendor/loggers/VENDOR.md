---
origin: ../loggers/public
owner: loggers
---

# Vendored: Loggers SDK

The **loggers repo owns the canonical current version** of every file in
this folder (except this one): `../loggers/public/`. The copies here must
be byte-identical to it at all times.

- **Never edit these files in pues** — fix upstream, then re-sync.
- Re-sync: `bun run scripts/vendor.ts` · verify: `scripts/vendor.ts --check`
  (run by `tests/vendor/drift.test.ts` as part of smoke).
