/**
 * Public wiki builder — clones public repos and generates wikis.
 *
 * Public wikis live in data/public.db (same per-user schema, just
 * shared and world-readable). They serve as SEO landing pages and
 * showcase what wikis.fyi can do.
 */
import { Database } from "bun:sqlite";
import { $ } from "bun";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "fs";
import { resolve, relative, extname } from "path";
import { Glob } from "bun";
import { getPublicDb } from "./db";
import { runAgent, type WikiConfig } from "./agent";
import { DATA_DIR } from "./constants";
import { log } from "./log";

const REPOS_DIR = resolve(DATA_DIR, "repos");

/** Default source globs for public repos. */
const DEFAULT_SOURCES = [
  "src/**/*.ts",
  "src/**/*.js",
  "lib/**/*.ts",
  "lib/**/*.js",
  "docs/**/*.md",
  "config/**/*.yml",
  "config/**/*.yaml",
  "README.md",
  "CLAUDE.md",
];

const DEFAULT_EXCLUDE = [
  "node_modules/**",
  "dist/**",
  ".git/**",
  "*.db",
  "*.lock",
  "bun.lock",
];

/** Default sections — empty means the LLM will plan them. */
const DEFAULT_SECTIONS: { name: string; description: string }[] = [];

export interface PublicWikiDef {
  repo: string;        // e.g. "https://github.com/legendum/depends.git"
  name: string;        // e.g. "depends"
  sections?: { name: string; description: string }[];
  sources?: string[];
}

/**
 * Clone or pull a repo, index sources, run the agent.
 */
export async function buildPublicWiki(def: PublicWikiDef, opts: { force?: boolean } = {}): Promise<void> {
  const db = getPublicDb();
  const repoDir = resolve(REPOS_DIR, def.name);

  // Clone or pull
  mkdirSync(REPOS_DIR, { recursive: true });
  if (existsSync(resolve(repoDir, ".git"))) {
    log.info(`Pulling ${def.name}`, { repo: def.repo });
    await $`cd ${repoDir} && git pull --ff-only`.quiet();
  } else {
    log.info(`Cloning ${def.name}`, { repo: def.repo });
    await $`git clone --depth 1 ${def.repo} ${repoDir}`.quiet();
  }

  // Ensure wiki exists in public DB
  let wiki = db.prepare("SELECT id FROM wikis WHERE name = ?").get(def.name) as { id: number } | null;
  if (!wiki) {
    db.prepare("INSERT INTO wikis (name, visibility) VALUES (?, 'public')").run(def.name);
    wiki = db.prepare("SELECT id FROM wikis WHERE name = ?").get(def.name) as { id: number };
  }

  // Collect source files
  const sources = def.sources || DEFAULT_SOURCES;
  const files = collectFiles(repoDir, sources, DEFAULT_EXCLUDE);

  log.info(`Collected ${files.length} source files for ${def.name}`);

  // Store source files — only update modified_at when content actually changed
  const hashContent = (await import("./storage")).hashContent;
  const now = new Date().toISOString();
  let changed = 0;
  for (const file of files) {
    const hash = hashContent(file.content);
    const existing = db.prepare(
      "SELECT hash FROM source_files WHERE wiki_id = ? AND path = ?"
    ).get(wiki.id, file.path) as { hash: string } | null;

    if (existing?.hash === hash) continue; // unchanged, skip

    db.prepare(`
      INSERT INTO source_files (wiki_id, path, content, hash, modified_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(wiki_id, path) DO UPDATE SET
        content = excluded.content,
        hash = excluded.hash,
        modified_at = excluded.modified_at
    `).run(wiki.id, file.path, file.content, hash, now);
    changed++;
  }
  log.info(`Stored ${files.length} source files for ${def.name} (${changed} changed)`);

  // Run the wiki agent
  const config: WikiConfig = {
    name: def.name,
    sections: def.sections || DEFAULT_SECTIONS,
  };

  log.info(`Running agent for ${def.name}${opts.force ? " (force)" : ""}`);
  const result = await runAgent(db, wiki.id, config, { reason: "public wiki build", force: opts.force });
  log.info(`Agent complete for ${def.name}`, {
    created: result.pagesCreated.length,
    updated: result.pagesUpdated.length,
    tokens: result.usage,
  });
}

/**
 * Collect files matching source globs, excluding excludes.
 */
function collectFiles(
  rootDir: string,
  sources: string[],
  exclude: string[]
): { path: string; content: string }[] {
  const files: { path: string; content: string }[] = [];
  const seen = new Set<string>();

  for (const pattern of sources) {
    const glob = new Glob(pattern);
    for (const match of glob.scanSync({ cwd: rootDir, absolute: false })) {
      if (seen.has(match)) continue;
      if (exclude.some((ex) => new Glob(ex).match(match))) continue;

      const fullPath = resolve(rootDir, match);
      try {
        const stat = statSync(fullPath);
        if (!stat.isFile() || stat.size > 512_000) continue; // skip files > 500KB

        const content = readFileSync(fullPath, "utf8");
        files.push({ path: match, content });
        seen.add(match);
      } catch {
        // skip unreadable files
      }
    }
  }

  return files;
}

/**
 * Build all configured public wikis.
 */
export async function buildAllPublicWikis(defs: PublicWikiDef[], opts: { force?: boolean } = {}): Promise<void> {
  for (const def of defs) {
    try {
      await buildPublicWiki(def, opts);
    } catch (e) {
      log.error(`Failed to build public wiki: ${def.name}`, { error: String(e) });
    }
  }
}
