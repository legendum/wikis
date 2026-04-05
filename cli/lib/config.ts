/**
 * CLI config — reads/writes ~/.config/wikis/config.yaml
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import yaml from "js-yaml";

const CONFIG_DIR = resolve(process.env.HOME || "~", ".config/wikis");
const CONFIG_PATH = resolve(CONFIG_DIR, "config.yaml");
const PROJECTS_PATH = resolve(CONFIG_DIR, "projects.yaml");

export interface CliConfig {
  account_key?: string;
  api_url?: string;
}

export interface ProjectEntry {
  path: string;
  name: string;
  last_check?: string;
}

export interface ProjectsConfig {
  projects: ProjectEntry[];
}

function ensureDir() {
  mkdirSync(CONFIG_DIR, { recursive: true });
}

export function readConfig(): CliConfig {
  if (!existsSync(CONFIG_PATH)) return {};
  return (yaml.load(readFileSync(CONFIG_PATH, "utf8")) as CliConfig) || {};
}

export function writeConfig(config: CliConfig): void {
  ensureDir();
  writeFileSync(CONFIG_PATH, yaml.dump(config, { lineWidth: 120 }));
}

export function readProjects(): ProjectsConfig {
  if (!existsSync(PROJECTS_PATH)) return { projects: [] };
  return (yaml.load(readFileSync(PROJECTS_PATH, "utf8")) as ProjectsConfig) || { projects: [] };
}

export function writeProjects(config: ProjectsConfig): void {
  ensureDir();
  writeFileSync(PROJECTS_PATH, yaml.dump(config, { lineWidth: 120 }));
}

export function addProject(entry: ProjectEntry): void {
  const config = readProjects();
  const existing = config.projects.findIndex((p) => p.path === entry.path);
  if (existing >= 0) {
    config.projects[existing] = entry;
  } else {
    config.projects.push(entry);
  }
  writeProjects(config);
}

export function removeProject(projectPath: string): boolean {
  const config = readProjects();
  const before = config.projects.length;
  config.projects = config.projects.filter((p) => p.path !== projectPath);
  if (config.projects.length < before) {
    writeProjects(config);
    return true;
  }
  return false;
}

export function getApiUrl(): string {
  return readConfig().api_url || "https://wikis.fyi";
}

export function getAccountKey(): string | null {
  return readConfig().account_key || null;
}

// --- Per-project file hashes ---

const HASHES_DIR = resolve(CONFIG_DIR, "hashes");
const DAEMON_PID_PATH = resolve(CONFIG_DIR, "daemon.pid");

export function readHashes(projectName: string): Record<string, string> {
  const p = resolve(HASHES_DIR, `${projectName}.json`);
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return {};
  }
}

export function writeHashes(projectName: string, hashes: Record<string, string>): void {
  mkdirSync(HASHES_DIR, { recursive: true });
  writeFileSync(resolve(HASHES_DIR, `${projectName}.json`), JSON.stringify(hashes));
}

// --- Daemon PID ---

export function readDaemonPid(): number | null {
  if (!existsSync(DAEMON_PID_PATH)) return null;
  const pid = parseInt(readFileSync(DAEMON_PID_PATH, "utf8").trim(), 10);
  return isNaN(pid) ? null : pid;
}

export function writeDaemonPid(pid: number): void {
  ensureDir();
  writeFileSync(DAEMON_PID_PATH, String(pid));
}

export function removeDaemonPid(): void {
  if (existsSync(DAEMON_PID_PATH)) {
    const { unlinkSync } = require("fs");
    unlinkSync(DAEMON_PID_PATH);
  }
}

export function isDaemonRunning(): boolean {
  const pid = readDaemonPid();
  if (!pid) return false;
  try {
    process.kill(pid, 0); // signal 0 = check if alive
    return true;
  } catch {
    return false;
  }
}

export { CONFIG_DIR, CONFIG_PATH, PROJECTS_PATH, HASHES_DIR, DAEMON_PID_PATH };
