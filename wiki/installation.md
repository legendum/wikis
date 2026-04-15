# Installation

The "wikis" project provides a CLI tool for managing personal AI-generated wikis. This page outlines the steps to install and set up the CLI, which enables watching project files, generating wiki pages via AI agents, and syncing with a server. The installation process prioritizes simplicity and cross-platform compatibility on macOS, Linux, and WSL through a shell script served from the server's public directory. This script handles dependency management, including automatic installation of the Bun runtime, chosen for its superior performance in executing TypeScript code and managing packages compared to Node.js.

## Prerequisites

A Unix-like shell such as Bash or Zsh is required, as the installation script relies on shell commands for environment detection and setup. Bun functions as the primary runtime. The script detects Bun's presence and installs it if missing, isolating it within the user's `~/.config/wikis` directory to avoid system-wide changes.

## Installation Steps

The server exposes static files from `PUBLIC_DIR` at the `/public/*` route, with specialized content-type handling for Markdown (`.md`) and text (`.txt`) files:

```typescript
.get("/public/*", ({ params }) => {
  const path = `${PUBLIC_DIR}/${params["*"]}`;
  const file = Bun.file(path);
  const lower = path.toLowerCase();
  if (lower.endsWith(".md")) {
    return new Response(file, {
      headers: { "Content-Type": CONTENT_TYPE_MARKDOWN_UTF8 },
    });
  }
  if (lower.endsWith(".txt")) {
    return new Response(file, {
      headers: { "Content-Type": CONTENT_TYPE_TEXT_UTF8 },
    });
  }
  return file;
})
```

Installation fetches this script via a single command:

```bash
curl -fsSL https://wikis.fyi/public/install.sh | sh
```

The script performs these steps:

1. Detects Bun and installs it from bun.sh if absent.
2. Clones or updates the repository into `~/.config/wikis/src`.
3. Executes `bun install` to manage dependencies.
4. Runs `bun link`, leveraging the `package.json` `bin` field (`"wikis": "cli/main.ts"`) to create a global symlink for the `wikis` command in the PATH, bypassing npm or Homebrew.

This approach confines the installation to `~/.config/wikis`, preventing global namespace pollution. Updates occur via `wikis update`, which pulls repository changes and reinstalls dependencies. See [cli-commands.md](cli-commands.md) for command details.

## Verifying the Installation

Confirm installation by displaying help output, which lists available commands and verifies PATH integration:

```bash
wikis --help
```

Success displays commands such as `wikis init` for project setup and `wikis serve` for the local server. PATH-related failures require shell restart or inspection of `~/.config/wikis`.

A machine-readable overview for LLMs appears at `/llms.txt` once the server runs, served similarly from `PUBLIC_DIR/llms.txt`.

## Self-Hosting the Server

For operation without the hosted service at wikis.fyi, install the CLI first, then execute `wikis serve`. This launches the complete Elysia server, bound by environment variables or `config/wikis.yml`:

```typescript
export const PORT = Number(process.env.PORT || rawConfig.port || 3000);
export const HOST = String(process.env.HOST || rawConfig.host || "0.0.0.0");
```

```typescript
const app = new Elysia()
  // ... routes ...
  .listen({ port: PORT, hostname: HOST });

console.log(`wikis.fyi running at http://${HOST}:${PORT}`);
```

Defaults bind to `http://0.0.0.0:3000`, configurable via `PORT`/`HOST` or the YAML file. A health endpoint verifies readiness:

```bash
curl http://localhost:3000/health
```

Expected response: `{"ok":true}`.

AI-driven generation requires API keys from environment variables or config—the first available provider activates:

```typescript
export const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY || (rawConfig.anthropic_api_key as string);
export const OPENAI_API_KEY = process.env.OPENAI_API_KEY || (rawConfig.openai_api_key as string);
export const XAI_API_KEY = process.env.XAI_API_KEY || (rawConfig.xai_api_key as string);
export const GEMINI_API_KEY = process.env.GEMINI_API_KEY || (rawConfig.gemini_api_key as string);
```

Embeddings leverage Ollama at `http://localhost:11434` (configurable via `OLLAMA_URL`/`OLLAMA_EMBED_MODEL`). See [search-features.md](search-features.md) for hybrid FTS5 + vector search details and [ai-generation.md](ai-generation.md) for agent orchestration.

The CLI daemon connects to the local instance by configuring `api_url: http://localhost:3000/api` in `~/.config/wikis/config.yml`. Consult [self-hosting.md](self-hosting.md) for complete setup, [architecture.md](architecture.md) for component integration, [configuration.md](configuration.md) for options, [syncing-mechanism.md](syncing-mechanism.md) for synchronization, and [cli-commands.md](cli-commands.md) for daemon management via `wikis start`.

## Next Steps

Execute `wikis init` in a project directory to generate `wiki/config.yml` and initiate the first build. Refer to [cli-commands.md](cli-commands.md) for commands, [configuration.md](configuration.md) for globs and settings, and [syncing-mechanism.md](syncing-mechanism.md) for file watching and sync.