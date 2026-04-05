#!/usr/bin/env bun

import { readFileSync } from 'fs';
/**
 * Build all public wikis from config/public-wikis.yml.
 *
 * Usage:
 *   bun run scripts/build-public-wikis.ts            # build (skips existing pages)
 *   bun run scripts/build-public-wikis.ts --fill      # just fill missing pages
 *   bun run scripts/build-public-wikis.ts --force     # regenerate all pages
 */
import yaml from 'js-yaml';
import { resolve } from 'path';
import {
  type AgentResult,
  fillMissingPages,
  type WikiConfig,
} from '../src/lib/agent';
import { getPublicDb } from '../src/lib/db';
import { log } from '../src/lib/log';
import {
  buildAllPublicWikis,
  type PublicWikiDef,
} from '../src/lib/public-wikis';

const configPath = resolve(import.meta.dir, '../config/public-wikis.yml');
const config = yaml.load(readFileSync(configPath, 'utf8')) as {
  wikis: PublicWikiDef[];
};

const fillOnly = process.argv.includes('--fill');
const force = process.argv.includes('--force');

if (fillOnly) {
  console.log(
    `Filling missing pages for ${config.wikis.length} public wiki(s)...`
  );
  const db = getPublicDb();

  for (const def of config.wikis) {
    const wiki = db
      .prepare('SELECT id FROM wikis WHERE name = ?')
      .get(def.name) as { id: number } | null;
    if (!wiki) {
      console.log(
        `Wiki "${def.name}" not found in DB — run a full build first.`
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
        `${def.name}: created ${result.pagesCreated.join(', ')} (${result.usage.input_tokens} in / ${result.usage.output_tokens} out)`
      );
    } else {
      console.log(`${def.name}: no missing pages.`);
    }
  }
} else {
  console.log(
    `Building ${config.wikis.length} public wiki(s)...${force ? ' (force regenerate)' : ''}`
  );
  await buildAllPublicWikis(config.wikis, { force });
}

console.log('Done.');
