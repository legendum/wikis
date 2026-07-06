import { readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

/**
 * Default host checkout root for a vendored pues tree (`<root>/pues/base/<part>/...`).
 * Defined under `base/core/` so three `..` segments reach `<root>`.
 */
export function defaultRoot(): string {
  return resolve(import.meta.dirname, "../../..");
}

/**
 * Default consumer slug from the host checkout root path.
 * Example: `/work/my-app` -> `my-app`.
 */
export function defaultCoreName(root: string = defaultRoot()): string {
  return basename(resolve(root));
}

/**
 * The consumer's `package.json` `name`, or undefined when the file is
 * missing, unparsable, or has no non-empty string name. A scoped name
 * keeps only its final segment (`@org/app` -> `app`): the core name
 * feeds file paths (db file, PWA manifest), where a `/` would act as a
 * directory separator.
 */
function packageJsonName(root: string): string | undefined {
  try {
    const raw = readFileSync(join(root, "package.json"), "utf8");
    const name = (JSON.parse(raw) as { name?: unknown }).name;
    if (typeof name === "string" && name.length > 0) {
      return name.includes("/") ? (name.split("/").pop() as string) : name;
    }
  } catch {
    // fall through to the folder basename
  }
  return undefined;
}

/**
 * Resolve the consumer's "app name" from a parsed `config/pues.yaml`:
 * `core.name` when set, else the `package.json` `name` (the deliberate
 * signal), else {@link defaultCoreName} (the checkout-folder basename).
 * Use everywhere code needs the canonical app identifier — db path, PWA
 * manifest, puesAppMeta codegen, etc. — instead of repeating the
 * fallback shape at each site.
 */
export function resolveCoreName(
  config: { core?: { name?: unknown } } | null | undefined,
  root: string = defaultRoot(),
): string {
  const explicit = config?.core?.name;
  if (typeof explicit === "string" && explicit.length > 0) return explicit;
  return packageJsonName(root) ?? defaultCoreName(root);
}
