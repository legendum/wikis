/**
 * wikis sync — one-shot sync: push source files, pull wiki pages.
 *
 * Usage:
 *   wikis sync         — sync current project
 *   wikis sync --all   — sync all registered projects
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { resolve } from "path";
const { parse } = Bun.YAML;
import { Glob } from "bun";
import { CryptoHasher } from "bun";
import { getApiUrl, getAccountKey, readProjects, writeProjects, readHashes, writeHashes } from "../lib/config";

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

  // Push sources
  const pushRes = await fetch(`${apiUrl}/api/sources`, {
    method: "POST",
    headers,
    body: JSON.stringify({ wiki: config.name, files: sourceFiles }),
  });

  if (!pushRes.ok) {
    console.error(`  Source push failed: ${pushRes.status} ${pushRes.statusText}`);
    return;
  }

  const pushData = (await pushRes.json()) as { ok: boolean; data?: { files: number; changed: number } };
  console.log(`  ${pushData.data?.changed || 0} file(s) changed.`);

  // Pull wiki pages
  const syncRes = await fetch(`${apiUrl}/api/sync`, {
    method: "POST",
    headers,
    body: JSON.stringify({ wiki: config.name, files: {} }),
  });

  if (!syncRes.ok) {
    console.error(`  Sync failed: ${syncRes.status} ${syncRes.statusText}`);
    return;
  }

  const syncData = (await syncRes.json()) as { ok: boolean; data?: { pull: string[] } };
  const pullPaths = syncData.data?.pull || [];

  if (pullPaths.length > 0) {
    const pullRes = await fetch(`${apiUrl}/api/pull`, {
      method: "POST",
      headers,
      body: JSON.stringify({ wiki: config.name, paths: pullPaths }),
    });

    if (pullRes.ok) {
      const pullData = (await pullRes.json()) as {
        ok: boolean;
        data?: { files: { path: string; content: string }[] };
      };
      const wikiDir = resolve(projectDir, "wiki");
      for (const file of pullData.data?.files || []) {
        const filePath = resolve(wikiDir, file.path);
        mkdirSync(resolve(filePath, ".."), { recursive: true });
        writeFileSync(filePath, file.content);
      }
      console.log(`  Pulled ${pullData.data?.files.length || 0} wiki page(s).`);
    }
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
