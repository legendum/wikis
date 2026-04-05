#!/usr/bin/env bun
/**
 * wikis CLI — entrypoint. Dispatches subcommands to cli/commands/*.ts.
 */

const COMMANDS: Record<string, { description: string; usage?: string }> = {
  init:    { description: "Initialize a wiki in the current project", usage: "wikis init" },
  login:   { description: "Authenticate with Legendum", usage: "wikis login [--key lak_...]" },
  sync:    { description: "Push sources and pull wiki pages", usage: "wikis sync [--all]" },
  start:   { description: "Start the background daemon", usage: "wikis start" },
  stop:    { description: "Stop the background daemon", usage: "wikis stop" },
  status:  { description: "Show daemon and project status", usage: "wikis status" },
  list:    { description: "List registered projects", usage: "wikis list" },
  remove:  { description: "Unregister the current project", usage: "wikis remove" },
  search:  { description: "Search wiki pages", usage: "wikis search <query>" },
  serve:   { description: "Start the web server", usage: "wikis serve" },
  update:  { description: "Update wikis to the latest version", usage: "wikis update" },
};

function printHelp() {
  console.log("wikis — personal AI-generated wikis\n");
  console.log("Usage: wikis <command> [options]\n");
  console.log("Commands:");
  const maxLen = Math.max(...Object.keys(COMMANDS).map((k) => k.length));
  for (const [name, { description }] of Object.entries(COMMANDS)) {
    console.log(`  ${name.padEnd(maxLen + 2)}${description}`);
  }
  console.log();
  console.log("Run 'wikis <command> --help' for command-specific usage.");
}

const args = process.argv.slice(2);
const command = args[0];

if (!command || command === "--help" || command === "-h" || command === "help") {
  printHelp();
  process.exit(0);
}

if (command === "--version" || command === "-v") {
  console.log("wikis 0.1.0");
  process.exit(0);
}

if (!COMMANDS[command]) {
  console.error(`Unknown command: ${command}\n`);
  printHelp();
  process.exit(1);
}

const { default: handler } = await import(`./commands/${command}.ts`);
await handler(args.slice(1));
