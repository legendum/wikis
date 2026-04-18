import { WIKIS_PUBLIC_ORIGIN } from "./constants";

/** Root URL for a wiki name (project slug). */
export function wikiRootUrl(wikiName: string): string {
  return `${WIKIS_PUBLIC_ORIGIN}/${encodeURIComponent(wikiName)}`;
}

/**
 * Public page URL for a wiki-relative path (e.g. `guides/Setup.md` → …/wiki/guides/Setup).
 * Matches browser routes under `/:project/*`.
 */
export function wikiPageUrl(wikiName: string, pagePath: string): string {
  const trimmed = pagePath.replace(/^\/+/, "");
  const noMd = trimmed.replace(/\.md$/i, "");
  if (!noMd) return wikiRootUrl(wikiName);
  const parts = noMd.split("/").filter(Boolean).map(encodeURIComponent);
  return `${WIKIS_PUBLIC_ORIGIN}/${encodeURIComponent(wikiName)}/${parts.join("/")}`;
}
