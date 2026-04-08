#!/usr/bin/env bun

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
/**
 * Build public wikis from config/public-wikis.yml.
 *
 * Usage:
 *   bun run scripts/build-public-wikis.ts                 # build all (skips existing pages)
 *   bun run scripts/build-public-wikis.ts --wiki <name>   # build only specific wiki
 *   bun run scripts/build-public-wikis.ts --list          # list available wikis
 *   bun run scripts/build-public-wikis.ts --fill          # just fill missing pages (all)
 *   bun run scripts/build-public-wikis.ts --fill --wiki <name>  # fill missing pages (specific)
 *   bun run scripts/build-public-wikis.ts --force         # regenerate all pages (all)
 *   bun run scripts/build-public-wikis.ts --force --wiki <name> # regenerate all pages (specific)
 */
import yaml from "js-yaml";
import {
  type AgentResult,
  fillMissingPages,
  type WikiConfig,
} from "../src/lib/agent";
import { getPublicDb } from "../src/lib/db";
import {
  buildAllPublicWikis,
  type PublicWikiDef,
} from "../src/lib/public-wikis";

const configPath = resolve(import.meta.dir, "../config/public-wikis.yml");
const config = yaml.load(readFileSync(configPath, "utf8")) as {
  wikis: PublicWikiDef[];
};

const fillOnly = process.argv.includes("--fill");
const force = process.argv.includes("--force");
const listOnly = process.argv.includes("--list");

const wikiArgIndex = process.argv.indexOf("--wiki");
const targetWiki = wikiArgIndex !== -1 ? process.argv[wikiArgIndex + 1] : null;

if (listOnly) {
  console.log("Available public wikis:");
  for (const wiki of config.wikis) {
    console.log(`  ${wiki.name} (${wiki.repo})`);
  }
  process.exit(0);
}

let wikisToProcess = config.wikis;
if (targetWiki) {
  const found = config.wikis.find((w) => w.name === targetWiki);
  if (!found) {
    console.error(
      `Wiki "${targetWiki}" not found. Use --list to see available wikis.`,
    );
    process.exit(1);
  }
  wikisToProcess = [found];
}

if (fillOnly) {
  console.log(
    `Filling missing pages for ${wikisToProcess.length} public wiki(s)...`,
  );
  const db = getPublicDb();

  for (const def of wikisToProcess) {
    const wiki = db
      .prepare("SELECT id FROM wikis WHERE name = ?")
      .get(def.name) as { id: number } | null;
    if (!wiki) {
      console.log(
        `Wiki "${def.name}" not found in DB — run a full build first.`,
      );
      continue;
    }

    const wikiConfig: WikiConfig = { name: def.name, sections: def.sections };
    const result: AgentResult = {
      pagesUpdated: [],
      pagesCreated: [],
      usage: { input_tokens: 0, output_tokens: 0 },
    };

    await fillMissingPages(db, wiki.id, wikiConfig, result);

    if (result.pagesCreated.length) {
      console.log(
        `${def.name}: created ${result.pagesCreated.join(", ")} (${result.usage.input_tokens} in / ${result.usage.output_tokens} out)`,
      );
    } else {
      console.log(`${def.name}: no missing pages.`);
    }
  }
} else {
  console.log(
    `Building ${wikisToProcess.length} public wiki(s)...${force ? " (force regenerate)" : ""}`,
  );
  await buildAllPublicWikis(wikisToProcess, { force });
}

console.log("Done.");
