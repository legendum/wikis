/**
 * POST /api/sync creates the wiki row if missing. Call before /api/sources,
 * which requires the wiki to exist.
 */
export async function ensureWikiRow(
  apiUrl: string,
  headers: Record<string, string>,
  wikiName: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const res = await fetch(`${apiUrl}/api/sync`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ wiki: wikiName, files: {} }),
  });
  if (!res.ok) {
    return { ok: false, error: `${res.status} ${res.statusText}` };
  }
  const data = (await res.json()) as { ok: boolean; error?: string };
  if (!data.ok) {
    return { ok: false, error: data.error || 'unknown error' };
  }
  return { ok: true };
}
