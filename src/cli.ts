#!/usr/bin/env bun

const args = process.argv.slice(2);
const command = args[0];

const commands: Record<string, () => Promise<void>> = {
  start: () => import("../cli/commands/start").then((m) => m.default(args.slice(1))),
  stop: () => import("../cli/commands/stop").then((m) => m.default(args.slice(1))),
  init: () => import("../cli/commands/init").then((m) => m.default(args.slice(1))),
  login: () => import("../cli/commands/login").then((m) => m.default(args.slice(1))),
  status: () => import("../cli/commands/status").then((m) => m.default(args.slice(1))),
  sync: () => import("../cli/commands/sync").then((m) => m.default(args.slice(1))),
  serve: () => import("../cli/commands/serve").then((m) => m.default(args.slice(1))),
  list: () => import("../cli/commands/list").then((m) => m.default(args.slice(1))),
  remove: () => import("../cli/commands/remove").then((m) => m.default(args.slice(1))),
  update: () => import("../cli/commands/update").then((m) => m.default(args.slice(1))),
  search: () => import("../cli/commands/search").then((m) => m.default(args.slice(1))),
};

async function main() {
  if (!command || command === "--help" || command === "-h") {
    console.log(`wikis — personal wiki service powered by LLMs

Usage: wikis <command>

Commands:
  init      Create wiki/ in current project and start first build
  start     Start the background daemon
  stop      Stop the daemon
  status    Show sync state and daemon health
  sync      Manual one-shot sync for current project
  list      List all registered projects
  remove    Unregister current project from the daemon
  login     Authenticate with Legendum
  serve     Run the wikis.fyi server locally
  search    Search wiki pages
  update    Update the CLI

Options:
  -h, --help    Show this help`);
    process.exit(0);
  }

  const handler = commands[command];
  if (!handler) {
    console.error(`Unknown command: ${command}\nRun 'wikis --help' for usage.`);
    process.exit(1);
  }

  await handler();
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
