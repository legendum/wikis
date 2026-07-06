// Pues-owned entry for the vendored Legendum SDK (provenance: VENDOR.md).
// Consumers: `import { legendum } from "pues/base/vendor/legendum"`.
// Server-side SDK (reads env/config) — vendor entries are uniformly
// index.ts; the parts' index-is-client-safe promise does not extend into
// base/vendor, and a browser bundle pulling this fails loudly at build.
export { default as legendum } from "./legendum.js";
// Types only: the SDK is CJS (`module.exports = sdk` via an identifier),
// so a runtime `export *` can't be statically resolved — the default
// export above is the whole runtime surface; the .d.ts types
// (LegendumTab, LinkControllerState, …) ride along here.
export type * from "./legendum.js";
