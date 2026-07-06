/**
 * `PUES_MANIFEST` — the canonical declaration of pues parts and their
 * inter-part dependencies. Single source of truth for the dependency
 * graph; when a new part lands or a dep changes, update here only.
 *
 * Consumed at vendor time by each consumer's `scripts/pues.ts` via the
 * peer path `../../pues/base/core/manifest`. The consumer's `pues:`
 * list in `config/pues.yaml` names the parts they want; `resolveDeps`
 * walks the manifest transitively and the script copies the closure.
 *
 * Lives in `core/` because the manifest is framework identity — what
 * pues *is*, not how it is delivered. Object-keyed `depends:` leaves
 * room for future fields (`optional:`, `conflicts_with:`) beside it.
 *
 * Not exported from `base/core/index.ts`: this is vendoring metadata,
 * not part of the runtime React/server surface. Importers reach in
 * via path (`pues/base/core/manifest`) deliberately.
 */

export const PUES_MANIFEST: Record<string, { depends: Record<string, true> }> =
  {
    a11y: { depends: { style: true } },
    ai: { depends: { core: true } },
    agent: { depends: { ai: true, core: true } },
    auth: { depends: { core: true, objects: true, theme: true, vendor: true } },
    billing: { depends: { auth: true, core: true, vendor: true } },
    cap: { depends: { core: true } },
    cli: { depends: { core: true } },
    core: { depends: {} },
    db: { depends: { core: true } },
    email: { depends: { core: true } },
    forms: { depends: { style: true } },
    health: { depends: { core: true } },
    markdown: { depends: { style: true } },
    meta: { depends: { core: true } },
    objects: { depends: { core: true, style: true } },
    pwa: { depends: { core: true, style: true } },
    sse: { depends: { core: true, style: true } },
    style: { depends: {} },
    test: { depends: { db: true } },
    theme: { depends: { core: true, forms: true, style: true } },
    vendor: { depends: {} },
    webhooks: { depends: { core: true } },
  };

/** Walk `PUES_MANIFEST` transitively from a list of requested parts.
 * Throws on an unknown part name — typoes in the consumer's `pues:`
 * list surface here. */
export function resolveDeps(requested: readonly string[]): string[] {
  const seen = new Set<string>();
  const walk = (p: string) => {
    if (seen.has(p)) return;
    seen.add(p);
    const entry = PUES_MANIFEST[p];
    if (!entry) {
      throw new Error(
        `Unknown pues part "${p}". Known: ${Object.keys(PUES_MANIFEST).join(", ")}.`,
      );
    }
    for (const dep of Object.keys(entry.depends)) walk(dep);
  };
  for (const p of requested) walk(p);
  return [...seen];
}
