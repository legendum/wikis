/**
 * Daemon process — polls registered projects for source file changes and syncs.
 * Spawned by `wikis start`, killed by `wikis stop`.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { resolve } from "path";
const { parse } = Bun.YAML;
import { Glob } from "bun";
import { CryptoHasher } from "bun";
import {
  readProjects,
  writeProjects,
  readHashes,
  writeHashes,
  writeDaemonPid,
  removeDaemonPid,
  getApiUrl,
  getAccountKey,
  getPollInterval,
} from "./config";
import { ensureWikiRow } from "./ensure-wiki";

const POLL_INTERVAL = getPollInterval();
const MAX_BACKOFF = 30 * 60 * 1000; // 30 minutes

// Track per-project error backoff: project name → { until: timestamp, delay: ms }
const backoff = new Map<string, { until: number; delay: number }>();

function hashFile(content: string): string {
  const hasher = new CryptoHasher("sha256");
  hasher.update(content);
  return hasher.digest("hex");
}

interface WikiConfig {
  name: string;
  sources: string[];
  exclude: string[];
}

async function gatherSourceHashes(
  projectDir: string,
  config: WikiConfig,
): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  for (const pattern of config.sources) {
    const glob = new Glob(pattern);
    for await (const file of glob.scan({ cwd: projectDir, absolute: false })) {
      const excluded = config.exclude?.some((ex) => new Glob(ex).match(file));
      if (excluded) continue;
      const fullPath = resolve(projectDir, file);
      if (!existsSync(fullPath)) continue;
      hashes[file] = hashFile(readFileSync(fullPath, "utf8"));
    }
  }
  return hashes;
}

function findChangedFiles(
  current: Record<string, string>,
  stored: Record<string, string>,
): string[] {
  const changed: string[] = [];
  for (const [path, hash] of Object.entries(current)) {
    if (stored[path] !== hash) changed.push(path);
  }
  return changed;
}

async function pullWikiPages(projectDir: string, config: WikiConfig, headers: Record<string, string>): Promise<number> {
  const apiUrl = getApiUrl();

  const syncRes = await fetch(`${apiUrl}/api/sync`, {
    method: "POST",
    headers,
    body: JSON.stringify({ wiki: config.name, files: {} }),
  });
  if (!syncRes.ok) return 0;

  const syncData = (await syncRes.json()) as { ok: boolean; data?: { pull: string[] } };
  const pullPaths = syncData.data?.pull || [];
  if (pullPaths.length === 0) return 0;

  const pullRes = await fetch(`${apiUrl}/api/pull`, {
    method: "POST",
    headers,
    body: JSON.stringify({ wiki: config.name, paths: pullPaths }),
  });
  if (!pullRes.ok) return 0;

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

  return pullData.data?.files.length || 0;
}

async function syncProject(projectDir: string, config: WikiConfig): Promise<boolean> {
  const apiUrl = getApiUrl();
  const accountKey = getAccountKey();
  if (!accountKey) return false;

  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${accountKey}`,
  };

  // Gather current file hashes
  const currentHashes = await gatherSourceHashes(projectDir, config);
  const storedHashes = readHashes(config.name);
  const changedPaths = findChangedFiles(currentHashes, storedHashes);

  // Push changed source files
  if (changedPaths.length > 0) {
    const files = changedPaths.map((path) => ({
      path,
      content: readFileSync(resolve(projectDir, path), "utf8"),
    }));

    const ensure = await ensureWikiRow(apiUrl, headers, config.name);
    if (!ensure.ok) {
      throw new Error(`Could not register wiki on server: ${ensure.error}`);
    }

    const res = await fetch(`${apiUrl}/api/sources`, {
      method: "POST",
      headers,
      body: JSON.stringify({ wiki: config.name, files }),
    });

    if (!res.ok) {
      throw new Error(`Source push failed: ${res.status}`);
    }

    writeHashes(config.name, currentHashes);
  }

  // Pull updated wiki pages
  const pulled = await pullWikiPages(projectDir, config, headers);

  // Update last_check
  const projects = readProjects();
  const entry = projects.projects.find((p) => p.path === projectDir);
  if (entry) {
    entry.last_check = new Date().toISOString();
    writeProjects(projects);
  }

  return changedPaths.length > 0 || pulled > 0;
}

async function pollOnce() {
  const { projects } = readProjects();

  for (const project of projects) {
    const configPath = resolve(project.path, "wiki", "config.yml");
    if (!existsSync(configPath)) continue;

    // Check backoff
    const bo = backoff.get(project.name);
    if (bo && bo.until > Date.now()) continue;

    try {
      const config = parse(readFileSync(configPath, "utf8")) as WikiConfig;
      const synced = await syncProject(project.path, config);
      if (synced) {
        console.log(`[${new Date().toISOString()}] Synced ${project.name}`);
      }
      backoff.delete(project.name);
    } catch (e) {
      const prev = backoff.get(project.name);
      const delay = Math.min(prev ? prev.delay * 2 : POLL_INTERVAL, MAX_BACKOFF);
      backoff.set(project.name, { until: Date.now() + delay, delay });
      console.error(`[${new Date().toISOString()}] Error syncing ${project.name}: ${(e as Error).message}`);
    }
  }
}

// --- Main loop ---

writeDaemonPid(process.pid);
console.log(`[${new Date().toISOString()}] Daemon started (PID ${process.pid})`);

process.on("SIGTERM", () => {
  console.log(`[${new Date().toISOString()}] Daemon stopping`);
  removeDaemonPid();
  process.exit(0);
});

process.on("SIGINT", () => {
  removeDaemonPid();
  process.exit(0);
});

// Initial poll, then interval
await pollOnce();
setInterval(pollOnce, POLL_INTERVAL);
