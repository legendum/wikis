# Vendor — `pues/base/vendor`

Canonical, verbatim copies of third-party / first-party SDKs, pues-owned so
every consumer shares **one** drift-checked copy instead of re-vendoring each
SDK per repo.

## Provides
- `pues/base/vendor/legendum` — Legendum billing SDK (`import { legendum }`)
- `pues/base/vendor/loggers` — Loggers SDK (`Loggers`, `Logger` type)
- `pues/base/vendor/marked` — Markdown renderer

## Config
`config/pues.yaml`: list `- vendor` under `pues:` (list it explicitly whenever
you import an SDK directly, even though other parts pull it transitively).

## Routes / mounts / interfaces
None. (Each SDK's own API is under **Provides**; talking to an external service
like legendum.co.uk is the SDK's concern, not a surface this part exposes.)

## Consume it
```ts
import { legendum } from "pues/base/vendor/legendum";
```
Each SDK is imported from its **entry directly** — a uniform `index.ts`, no
`/server` suffix. (That's the vendor exception: most server-side parts import
from `pues/base/<part>/server`.)

Client code that needs a browser-safe piece imports the **file**, not the entry:
```ts
require("pues/base/vendor/legendum/legendum.js").linkController
```

## Notes
- Vendor entries are **server-side** (e.g. legendum reads `LEGENDUM_API_KEY` +
  `LEGENDUM_SECRET` for hosted billing); a browser bundle importing the entry
  fails loudly at build — use the file path above for client-safe bits.
- Exclude the vendored tree from biome (`!pues`, `!types/pues`, `!scripts/pues.ts`
  in `files.includes`) so `lint:fix` can never mutate SDK bytes.
- Never edit the vendored copy. Ownership flows owner-repo → pues → consumer;
  the SDK bytes under `base/vendor` are drift-checked by pues's own
  `scripts/vendor.ts` (which is *only* about this part — the general vendoring
  of parts into a consumer is done by that consumer's `scripts/pues.ts`).
