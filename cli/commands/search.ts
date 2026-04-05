/**
 * wikis search <query> — search wiki pages via the API.
 */
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { parse } from "yaml";
import { getApiUrl, getAccountKey } from "../lib/config";

export default async function search(args: string[]) {
  const query = args.join(" ").trim();
  if (!query) {
    console.error("Usage: wikis search <query>");
    process.exit(1);
  }

  const configPath = resolve(process.cwd(), "wiki", "config.yml");
  if (!existsSync(configPath)) {
    console.error("No wiki/config.yml found. Run 'wikis init' first.");
    process.exit(1);
  }

  const config = parse(readFileSync(configPath, "utf8"));
  const wikiName = config.name;
  const apiUrl = getApiUrl();
  const accountKey = getAccountKey();

  const url = `${apiUrl}/api/search/${encodeURIComponent(wikiName)}?q=${encodeURIComponent(query)}`;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (accountKey) headers.Authorization = `Bearer ${accountKey}`;

  try {
    const res = await fetch(url, { headers });
    if (!res.ok) {
      console.error(`Search failed: ${res.status} ${res.statusText}`);
      process.exit(1);
    }

    const json = (await res.json()) as {
      ok: boolean;
      data?: { results: { path: string; chunk: string; score: number }[] };
    };
    const results = json.data?.results;
    if (!results?.length) {
      console.log("No results.");
      return;
    }

    for (const r of results) {
      const title = r.path.replace(/\.md$/, "").replace(/-/g, " ");
      const snippet = r.chunk.slice(0, 120).replace(/\n/g, " ");
      console.log(`  ${title} (${r.path})`);
      console.log(`    ${snippet}…`);
      console.log();
    }
  } catch (e) {
    console.error(`Failed to connect to ${apiUrl}: ${(e as Error).message}`);
    process.exit(1);
  }
}
