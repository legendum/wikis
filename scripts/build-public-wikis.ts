#!/usr/bin/env bun

/**
 * Build all public wikis from config/public-wikis.yml.
 *
 * Usage:
 *   bun run scripts/build-public-wikis.ts          # full rebuild
 *   bun run scripts/build-public-wikis.ts --fill    # just fill missing pages (no rebuild)
 */
import yaml from "js-yaml";
import { readFileSync } from "fs";
import { resolve } from "path";
import { buildAllPublicWikis, type PublicWikiDef } from "../src/lib/public-wikis";
import { fillMissingPages, type WikiConfig, type AgentResult } from "../src/lib/agent";
import { getPublicDb } from "../src/lib/db";
import { log } from "../src/lib/log";

const configPath = resolve(import.meta.dir, "../config/public-wikis.yml");
const config = yaml.load(readFileSync(configPath, "utf8")) as { wikis: PublicWikiDef[] };

const fillOnly = process.argv.includes("--fill");

if (fillOnly) {
  console.log(`Filling missing pages for ${config.wikis.length} public wiki(s)...`);
  const db = getPublicDb();

  for (const def of config.wikis) {
    const wiki = db.prepare("SELECT id FROM wikis WHERE name = ?").get(def.name) as { id: number } | null;
    if (!wiki) {
      console.log(`Wiki "${def.name}" not found in DB — run a full build first.`);
      continue;
    }

    const wikiConfig: WikiConfig = { name: def.name, sections: def.sections };
    const result: AgentResult = { pagesUpdated: [], pagesCreated: [], usage: { input_tokens: 0, output_tokens: 0 } };

    await fillMissingPages(db, wiki.id, wikiConfig, result);

    if (result.pagesCreated.length) {
      console.log(`${def.name}: created ${result.pagesCreated.join(", ")} (${result.usage.input_tokens} in / ${result.usage.output_tokens} out)`);
    } else {
      console.log(`${def.name}: no missing pages.`);
    }
  }
} else {
  console.log(`Building ${config.wikis.length} public wiki(s)...`);
  await buildAllPublicWikis(config.wikis);
}

console.log("Done.");
