---
name: pues-pwa-setup
description: Wire the Pues PWA part — build manifest + service worker, serve them from Bun, register the SW on the client, and confirm required assets exist. Use when adding offline/installable support, debugging "PWA not installable" errors, or verifying icons after a rename.
---
# Pues PWA Setup

## What Pues Handles For You
Don't reimplement these — the `pwa` part already does them:

- **Manifest generation** (`buildPwaManifest`) — derives `name`, `short_name`,
  colours, and icon paths from `config/pues.yaml`. `pwa.*` overrides; otherwise
  `name` falls back to capitalised `core.name`, colours to `style.dark`.
- **Service-worker build** (`buildServiceWorker`) — runs workbox, precaches the
  manifest + icons, emits `dist/sw.js` + hash-named runtime chunks.
- **`buildPwa`** — one call that does both, wires the manifest revision into
  the precache (so a manifest edit busts SW cache on deploy), and defaults
  `cacheId` to `<pkg.name>-<pkg.version>`.
- **`mountPwaRoutes`** — serves `/manifest.json`, `/dist/sw.js` (with the right
  `Service-Worker-Allowed` / `Cache-Control` headers), the two icon URLs, and
  via its `fetch` fall-through the hash-named `dist/workbox-*.js` chunks.
- **`registerServiceWorker`** — handles registration + `controllerchange`
  auto-reload; no-ops where SW is unavailable.
- **`onReconnect`** — client-side online/offline bridge for "back online" UX.

Vendoring `pwa` implies vendoring `style` (manifest colours fall back to
`style.dark`). See [[../pues-service-bootstrap/SKILL.md|pues-service-bootstrap]] for vendoring mechanics.

## 1) Consumer-Supplied Icons in `public/`
The minimum the consumer must ship is the **main** icon at
`public/<core-name>.png` (e.g. `public/my-app.png`). `buildPwa` will
auto-generate the 192 and 512 PWA variants from it when:

- The resolved `pwa.icon192` / `pwa.icon512` URLs match the convention
  (`/<core-name>-192.png` / `/<core-name>-512.png`).
- The target files don't already exist (manually-authored icons are
  never overwritten).

Auto-resize uses `Bun.file(src).image().resize(size, size, { fit:
"inside" }).png().write(dest)`. Source should be square — square
sources produce exactly N×N. Non-square sources are preserved in
aspect ratio (not centre-cropped). PNG output; switch formats by
shipping the variants yourself and overriding `pwa.icon*` URLs.

Important path rule:
- `public/...` is the filesystem location.
- `pwa.icon192` / `pwa.icon512` are URL paths.
- Example: `public/my-app-192.png` is served at `/my-app-192.png`.

Recommended (avoid rename/path drift): set explicit icon URLs in
`config/pues.yaml` even when they match defaults:

```yaml
pwa:
  icon192: /my-app-192.png
  icon512: /my-app-512.png
```

Default naming still works when `pwa.icon*` is omitted:
- `public/<core-name>-192.png` -> `/<core-name>-192.png`
- `public/<core-name>-512.png` -> `/<core-name>-512.png`

`<core-name>` is `core.name` from `config/pues.yaml` (or checkout folder
name if unset). If renamed (`old-name` -> `new-name`) and icons weren't
renamed or overridden, URLs 404 and installability breaks.

Quick check before build:
- `ls public/*.png` — at minimum `<core-name>.png`.
- The 192/512 variants are auto-generated if absent; commit them so
  CI/deploy builds aren't generating identical files on every run.

## 2) Build Step
Add a `scripts/build-pwa.ts` (or fold into the existing build) that calls
`buildPwa`. List every static asset the SPA fetches as `additionalAssets` —
the generated manifest and the two icons are added automatically; anything
else (CSS, fonts, images) must be listed explicitly or it breaks offline.

`buildPwa` handles the conventional 192/512 auto-resize itself (see §1).
Don't reimplement that in the build script. If the canonical
`public/<core-name>.png` is missing and the 192/512 variants aren't
shipped manually, the build fails loudly during precache — the right
loud-fail signal.

```ts
import { buildPwa } from "pues/base/pwa/server";

await buildPwa({
  root: process.cwd(),
  additionalAssets: [
    { url: "/index.html", path: "public/index.html" },
    { url: "/assets/app.css", path: "public/assets/app.css" },
  ],
});
```

`cacheId` defaults to `<pkg.name>-<pkg.version>`; bumping `package.json`
version is the canonical way to force a SW cache bust on deploy.

## 3) Server Wiring
`mountPwaRoutes` returns `{ routes, fetch }` — spread the routes **and** call
the fetch fall-through, or workbox's hash-named runtime chunks will 404.

```ts
import { mountPwaRoutes } from "pues/base/pwa/server";

const pwa = await mountPwaRoutes({ root: process.cwd() });

export default {
  routes: { ...pwa.routes, ...puesSse.routes /* etc */ },
  async fetch(req: Request) {
    const pwaHit = await pwa.fetch(req);
    if (pwaHit) return pwaHit;
    return new Response("Not found", { status: 404 });
  },
};
```

## 4) Client Registration
One line at the SPA entry point:

```ts
import { registerServiceWorker } from "pues/base/pwa";

registerServiceWorker(); // defaults: /dist/sw.js, scope /, reload on controllerchange
```

For "back online" UX, pair with `onReconnect((online) => …)` from the same
barrel — it bridges `navigator.onLine` + `online`/`offline` events.

## 5) Offline Cold-Reload UX
For PWA-installed apps, two pues primitives turn cold reload into a
useful experience instead of a blank screen while the network fetch
resolves:

- `useOnlineStatus()` from `pues/base/core` — re-renders on
  `online` / `offline` events. Use for "you're offline" banners or to
  gate background sync code paths.
- `useOfflineRowCache(resource, opts)` from `pues/base/objects` —
  mirrors `resource.rows` into IndexedDB on every change. Detail-page
  URLs resolve from the cache via `useSlugRouting.resolveExternal`
  even before the live fetch arrives.

See [[../pues-objects-resource-setup/SKILL.md|pues-objects-resource-setup]] §7 for the cache wiring pattern.

## Checklist
- [ ] `pwa.icon192` + `pwa.icon512` are explicitly set for the consumer, or
      the default `<core-name>-{192,512}.png` naming is intentionally used.
- [ ] At minimum the canonical `public/<core-name>.png` exists — the
      192/512 variants are auto-generated by `buildPwa` if missing.
- [ ] `mountPwaRoutes`'s `fetch` is wired as a fall-through, not just
      `routes` spread (otherwise workbox chunks 404).
- [ ] Every static asset the SPA fetches is either a pues default (manifest,
      icons) or listed in `additionalAssets`.
- [ ] `package.json` version is bumped on deploys that should bust the SW cache.
- [ ] `registerServiceWorker()` is called once in the web entry point.
