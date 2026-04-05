/**
 * Daemon process — polls registered projects for source file changes and syncs.
 * Spawned by `wikis start`, killed by `wikis stop`.
 */
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { parse } from "yaml";
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
} from "./config";

const POLL_INTERVAL = 5 * 60 * 1000; // 5 minutes
const MAX_BACKOFF = 30 * 60 * 1000; // 30 minutes

// Track per-project error backoff
const backoff = new Map<string, number>();

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

  if (changedPaths.length === 0) return false;

  // Only push changed files
  const files = changedPaths.map((path) => ({
    path,
    content: readFileSync(resolve(projectDir, path), "utf8"),
  }));

  const res = await fetch(`${apiUrl}/api/sources`, {
    method: "POST",
    headers,
    body: JSON.stringify({ wiki: config.name, files }),
  });

  if (!res.ok) {
    throw new Error(`Source push failed: ${res.status}`);
  }

  // Update stored hashes
  writeHashes(config.name, currentHashes);

  // Update last_check
  const projects = readProjects();
  const entry = projects.projects.find((p) => p.path === projectDir);
  if (entry) {
    entry.last_check = new Date().toISOString();
    writeProjects(projects);
  }

  return true;
}

async function pollOnce() {
  const { projects } = readProjects();

  for (const project of projects) {
    const configPath = resolve(project.path, "wiki", "config.yml");
    if (!existsSync(configPath)) continue;

    // Check backoff
    const wait = backoff.get(project.name) || 0;
    if (wait > Date.now()) continue;

    try {
      const config = parse(readFileSync(configPath, "utf8")) as WikiConfig;
      const synced = await syncProject(project.path, config);
      if (synced) {
        console.log(`[${new Date().toISOString()}] Synced ${project.name} (changed files detected)`);
      }
      backoff.delete(project.name);
    } catch (e) {
      const current = backoff.get(project.name);
      const delay = current ? Math.min((Date.now() - current) * 2, MAX_BACKOFF) : POLL_INTERVAL;
      backoff.set(project.name, Date.now() + delay);
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
