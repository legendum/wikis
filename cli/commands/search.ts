/**
 * wikis search <query> — search wiki pages via the API or locally.
 */
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { parse } from "yaml";

export default async function search(args: string[]) {
  const query = args.join(" ").trim();
  if (!query) {
    console.error("Usage: wikis search <query>");
    process.exit(1);
  }

  // Read local wiki config to get wiki name and server URL
  const configPath = resolve(process.cwd(), "wiki", "config.yml");
  if (!existsSync(configPath)) {
    console.error("No wiki/config.yml found. Run 'wikis init' first.");
    process.exit(1);
  }

  const config = parse(readFileSync(configPath, "utf8"));
  const wikiName = config.name;
  const server = config.server || "https://wikis.fyi";
  const token = config.token || process.env.WIKIS_TOKEN;

  const url = `${server}/api/search/${encodeURIComponent(wikiName)}?q=${encodeURIComponent(query)}`;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;

  try {
    const res = await fetch(url, { headers });
    if (!res.ok) {
      console.error(`Search failed: ${res.status} ${res.statusText}`);
      process.exit(1);
    }

    const json = (await res.json()) as { ok: boolean; data?: { results: { path: string; chunk: string; score: number }[] } };
    const data = json.data;
    if (!data.results?.length) {
      console.log("No results.");
      return;
    }

    for (const r of data.results) {
      const title = r.path.replace(/\.md$/, "").replace(/-/g, " ");
      const snippet = r.chunk.slice(0, 120).replace(/\n/g, " ");
      console.log(`  ${title} (${r.path})`);
      console.log(`    ${snippet}...`);
      console.log();
    }
  } catch (e) {
    console.error(`Failed to connect to ${server}: ${(e as Error).message}`);
    process.exit(1);
  }
}
