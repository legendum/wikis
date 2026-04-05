import { existsSync, mkdirSync, writeFileSync } from "fs";
import { resolve, basename } from "path";
import yaml from "js-yaml";

const DEFAULT_CONFIG = {
  name: "",
  sources: ["src/**/*", "docs/**/*", "config/**/*", "README.md"],
  exclude: ["node_modules/**", "*.db", ".env", "wiki/**"],
  sections: [
    { name: "Overview", description: "What this project does and why" },
    {
      name: "Architecture",
      description: "How the system is designed — components, data flow, key decisions",
    },
    { name: "Setup", description: "Getting started, installation, deployment" },
  ],
};

export default async function init(_args: string[]) {
  const projectDir = process.cwd();
  const wikiDir = resolve(projectDir, "wiki");
  const configPath = resolve(wikiDir, "config.yml");

  if (existsSync(configPath)) {
    console.log("wiki/config.yml already exists in this project.");
    return;
  }

  // Scaffold wiki/
  mkdirSync(resolve(wikiDir, "pages"), { recursive: true });

  // Generate config with project name from directory
  const config = { ...DEFAULT_CONFIG, name: basename(projectDir) };
  writeFileSync(configPath, yaml.dump(config, { lineWidth: 120 }));

  // Create empty index and log
  writeFileSync(resolve(wikiDir, "index.md"), `# ${config.name}\n\nWiki index — maintained automatically.\n`);
  writeFileSync(resolve(wikiDir, "log.md"), `# Changelog\n`);

  // Generate MCP config
  const mcpConfig = {
    mcpServers: {
      wikis: {
        type: "http",
        url: "https://wikis.fyi/mcp",
        headers: {
          Authorization: "Bearer <your-account-key>",
        },
      },
    },
  };
  writeFileSync(resolve(wikiDir, "mcp.json"), JSON.stringify(mcpConfig, null, 2) + "\n");

  console.log(`Initialized wiki/ in ${projectDir}`);
  console.log(`  config:  wiki/config.yml`);
  console.log(`  index:   wiki/index.md`);
  console.log(`  log:     wiki/log.md`);
  console.log(`  mcp:     wiki/mcp.json`);
  console.log(`\nEdit wiki/config.yml to configure sources and sections.`);

  // TODO: register project with daemon, trigger first build
}
