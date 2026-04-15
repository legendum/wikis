/**
 * wikis sync — one-shot sync: push source files, pull wiki pages.
 *
 * Usage:
 *   wikis sync         — sync current project
 *   wikis sync --all   — sync all registered projects
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const { parse } = Bun.YAML;

import { CryptoHasher, Glob } from "bun";
import {
  getAccountKey,
  getApiUrl,
  readProjects,
  writeHashes,
  writeProjects,
} from "../lib/config";
import { ensureWikiRow } from "../lib/ensure-wiki";
import { syncWikiPages } from "../lib/wiki-sync";

interface WikiConfig {
  name: string;
  sources: string[];
  exclude: string[];
}

async function syncProject(projectDir: string) {
  const configPath = resolve(projectDir, "wiki", "config.yml");
  if (!existsSync(configPath)) {
    console.error(`  No wiki/config.yml in ${projectDir}. Skipping.`);
    return;
  }

  const config = parse(readFileSync(configPath, "utf8")) as WikiConfig;
  const apiUrl = getApiUrl();
  const accountKey = getAccountKey();

  if (!accountKey) {
    console.error("  Not authenticated. Run 'wikis login' first.");
    process.exit(1);
  }

  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${accountKey}`,
  };

  // Gather source files
  const sourceFiles: { path: string; content: string }[] = [];
  for (const pattern of config.sources) {
    const glob = new Glob(pattern);
    for await (const file of glob.scan({ cwd: projectDir, absolute: false })) {
      // Check exclude patterns
      const excluded = config.exclude?.some((ex) => {
        const exGlob = new Glob(ex);
        return exGlob.match(file);
      });
      if (excluded) continue;

      const fullPath = resolve(projectDir, file);
      if (!existsSync(fullPath)) continue;
      sourceFiles.push({
        path: file,
        content: readFileSync(fullPath, "utf8"),
      });
    }
  }

  console.log(`  Pushing ${sourceFiles.length} source file(s)…`);

  const ensure = await ensureWikiRow(apiUrl, headers, config.name);
  if (!ensure.ok) {
    console.error(`  Could not register wiki on server: ${ensure.error}`);
    return;
  }

  // Push sources
  const pushRes = await fetch(`${apiUrl}/api/sources`, {
    method: "POST",
    headers,
    body: JSON.stringify({ wiki: config.name, files: sourceFiles }),
  });

  if (!pushRes.ok) {
    console.error(
      `  Source push failed: ${pushRes.status} ${pushRes.statusText}`,
    );
    return;
  }

  const pushData = (await pushRes.json()) as {
    ok: boolean;
    error?: string;
    data?: { files: number; changed: number; queued_regeneration?: boolean };
  };
  if (!pushData.ok) {
    console.error(`  Source push failed: ${pushData.error || "unknown error"}`);
    return;
  }
  const changed = pushData.data?.changed || 0;
  const queued = pushData.data?.queued_regeneration;
  if (changed === 0 && queued) {
    console.log(
      `  0 file(s) changed; wiki build queued (no generated pages on the server yet).`,
    );
  } else {
    console.log(`  ${changed} file(s) changed.`);
  }

  // Bidirectional wiki/*.md sync (push local edits, then pull)
  let wikiPushed = 0;
  let wikiPulled = 0;
  try {
    const wiki = await syncWikiPages(projectDir, config.name, apiUrl, headers);
    wikiPushed = wiki.pushed;
    wikiPulled = wiki.pulled;
  } catch (e) {
    console.error(`  Wiki sync failed: ${(e as Error).message}`);
    return;
  }
  if (wikiPushed > 0 || wikiPulled > 0) {
    console.log(
      `  Wiki: pushed ${wikiPushed} page(s), pulled ${wikiPulled} page(s).`,
    );
  } else {
    console.log(`  Wiki pages up to date.`);
  }

  // Store file hashes so daemon knows what's changed next time
  const hashes: Record<string, string> = {};
  for (const f of sourceFiles) {
    const hasher = new CryptoHasher("sha256");
    hasher.update(f.content);
    hashes[f.path] = hasher.digest("hex");
  }
  writeHashes(config.name, hashes);

  // Update last check time
  const projects = readProjects();
  const entry = projects.projects.find((p) => p.path === projectDir);
  if (entry) {
    entry.last_check = new Date().toISOString();
    writeProjects(projects);
  }

  console.log(`  Done.`);
}

export default async function sync(args: string[]) {
  if (args.includes("--all")) {
    const { projects } = readProjects();
    if (projects.length === 0) {
      console.log("No projects registered.");
      return;
    }
    for (const p of projects) {
      console.log(`Syncing ${p.name}…`);
      await syncProject(p.path);
    }
  } else {
    const projectDir = process.cwd();
    console.log(`Syncing…`);
    await syncProject(projectDir);
  }
}
