---
origin: https://github.com/markedjs/marked/releases/tag/v17.0.5
owner: markedjs/marked
pinned: 17.0.5
---

# Vendored: marked (external, hand-vendored)

Third-party Markdown parser/renderer, held at a **known-good pinned
version** in our own source control instead of trusting `bun install` to
resolve a good one (npm supply-chain risk; this file is served to and run
in browsers).

- **Pinned:** `17.0.5` — the fleet's highest lockfile-vetted version
  (chats2me locks `17.0.5`, alerting `17.0.2`; both ranges are satisfied,
  nobody downgrades on adoption). Fetched from the npm registry tarball
  `marked-17.0.5.tgz`; MIT, see `LICENSE.md` here.
- **sha256 (`marked.esm.js`):**
  `0b4487359ce6b85108708e7a532e1242a27f4718241e7b2de109ac6cd307d2dc`
- **External folder**: the origin is a URL, so `scripts/vendor.ts` never
  syncs or drift-checks it — upgrades are a deliberate human act: fetch
  the new release, verify, update the pin + hash here, disclose in
  TAGS.md.
- Vendored: `marked.esm.js` (ESM — Bun and browsers), `marked.esm.js.map`
  (the file's tail points at it; without it devtools 404), upstream
  `lib/marked.d.ts` saved as **`marked.esm.d.ts`** (same basename as the
  `.js` so tsc pairs them; npm's `exports` map did that job upstream),
  `LICENSE.md`. Not vendored: UMD build, `bin/`, `man/`.
- Consumers: `import { marked } from "pues/base/vendor/marked"` (the
  pues-owned `index.ts` entry here) and drop the npm `marked` dependency
  on adoption.
