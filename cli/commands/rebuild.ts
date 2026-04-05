/**
 * wikis rebuild — trigger wiki page regeneration on the server.
 *
 * Usage:
 *   wikis rebuild          — regenerate changed pages
 *   wikis rebuild --force  — regenerate all pages from scratch
 */
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { getApiUrl, getAccountKey } from "../lib/config";

const { parse } = Bun.YAML;

export default async function rebuild(args: string[]) {
  const force = args.includes("--force");

  const configPath = resolve(process.cwd(), "wiki", "config.yml");
  if (!existsSync(configPath)) {
    console.error("No wiki/config.yml found. Run 'wikis init' first.");
    process.exit(1);
  }

  const config = parse(readFileSync(configPath, "utf8")) as { name: string };
  const apiUrl = getApiUrl();
  const accountKey = getAccountKey();

  if (!accountKey) {
    console.error("Not authenticated. Run 'wikis login' first.");
    process.exit(1);
  }

  console.log(`Rebuilding ${config.name}${force ? " (force)" : ""}...`);

  try {
    const res = await fetch(`${apiUrl}/api/rebuild`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accountKey}`,
      },
      body: JSON.stringify({ wiki: config.name, force }),
    });

    const data = (await res.json()) as {
      ok: boolean;
      data?: { created: number; updated: number; pages_created: string[]; pages_updated: string[] };
      message?: string;
    };

    if (!data.ok) {
      console.error(`Rebuild failed: ${data.message || "unknown error"}`);
      process.exit(1);
    }

    const { created, updated } = data.data!;
    console.log(`Done — ${created} page(s) created, ${updated} page(s) updated.`);

    // Pull the new pages locally
    if (created > 0 || updated > 0) {
      console.log("Pulling updated pages...");
      const { default: sync } = await import("./sync");
      await sync([]);
    }
  } catch (e) {
    console.error(`Could not reach ${apiUrl}: ${(e as Error).message}`);
    process.exit(1);
  }
}
