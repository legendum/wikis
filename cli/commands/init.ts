import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import yaml from "js-yaml";
import {
  addProject,
  getAccountKey,
  getApiUrl,
  isDaemonRunning,
} from "../lib/config";

const DEFAULT_CONFIG = {
  name: "",
  sources: ["src/**/*", "docs/**/*", "config/**/*", "README.md"],
  exclude: ["node_modules/**", "*.db", ".env", "wiki/**"],
};

async function prompt(message: string): Promise<string> {
  process.stdout.write(message);
  for await (const line of console) {
    return line.trim();
  }
  return "";
}

export default async function init(_args: string[]) {
  const projectDir = process.cwd();
  const wikiDir = resolve(projectDir, "wiki");
  const configPath = resolve(wikiDir, "config.yml");

  if (existsSync(configPath)) {
    console.log("wiki/config.yml already exists in this project.");
    return;
  }

  // 1. Create wiki/ directory and config files
  mkdirSync(wikiDir, { recursive: true });

  const name = basename(projectDir);
  const config = { ...DEFAULT_CONFIG, name };
  writeFileSync(configPath, yaml.dump(config, { lineWidth: 120 }));
  writeFileSync(
    resolve(wikiDir, "index.md"),
    `# ${name}\n\nWiki index — maintained automatically.\n`,
  );
  writeFileSync(resolve(wikiDir, "log.md"), `# Changelog\n`);

  // Register with projects list
  addProject({ path: projectDir, name });

  console.log(`Initialized wiki/ in ${projectDir}`);
  console.log(`  config:  wiki/config.yml`);
  console.log(`  index:   wiki/index.md`);
  console.log(`  log:     wiki/log.md`);

  // 2. Login if first time (no config exists yet)
  let accountKey = getAccountKey();
  const firstTime = !existsSync(
    resolve(process.env.HOME || "~", ".config/wikis/config.yaml"),
  );
  if (!accountKey && firstTime) {
    console.log();
    const key = await prompt(
      "Legendum account key (see legendum.co.uk), or press Enter to skip: ",
    );
    if (key) {
      try {
        const { default: login } = await import("./login");
        await login([key]);
        accountKey = key;
      } catch {
        console.log("Login failed — continuing without authentication.");
      }
    } else {
      console.log("Skipped — running in self-hosted mode.");
    }
  }

  // 3. Write MCP config
  const apiUrl = getApiUrl();
  const mcpConfig = {
    mcpServers: {
      wikis: {
        type: "http",
        url: `${apiUrl}/api/mcp`,
        headers: {
          Authorization: "Bearer <your-legendum-account-key>",
        },
      },
    },
  };
  writeFileSync(
    resolve(wikiDir, "mcp.json"),
    `${JSON.stringify(mcpConfig, null, 2)}\n`,
  );
  console.log(
    `  mcp:     wiki/mcp.json (edit to add your Legendum account key)`,
  );

  // 4. First sync
  if (accountKey) {
    console.log();
    console.log("Syncing sources...");
    try {
      const { default: sync } = await import("./sync");
      await sync([]);
    } catch (e) {
      console.error(`Sync failed: ${(e as Error).message}`);
      console.log("You can retry with 'wikis sync'.");
    }
  }

  // 5. Start daemon if not already running
  if (!isDaemonRunning()) {
    console.log();
    try {
      const { default: start } = await import("./start");
      await start([]);
    } catch (_e) {
      console.log("Could not start daemon. Run 'wikis start' manually.");
    }
  }

  console.log();
  console.log("Done! Edit wiki/config.yml to customize sources.");
}
