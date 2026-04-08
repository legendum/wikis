# Installation

The "wikis" project provides a CLI tool for managing personal AI-generated wikis. This page outlines the steps to install and set up the CLI, enabling users to watch project files, generate wiki pages via AI agents, and sync with a server. The process emphasizes simplicity and automation through a shell script hosted in the server's public directory. This script manages dependencies, including the Bun runtime, to ensure compatibility across macOS, Linux, and WSL.

## Prerequisites

The CLI requires a Unix-like shell, such as Bash or Zsh, as the installation script uses shell commands for environment detection and setup. Bun serves as the primary runtime, selected for its performance in executing TypeScript code and handling packages faster than Node.js. The script automatically detects and installs Bun if absent, isolating it to the user's configuration directory.

## Installation Steps

Installation uses a single command to fetch the shell script from the server's public endpoint. The server exposes static files from `PUBLIC_DIR` at `/public/*`, with content-type handling for markdown (`.md`) and text (`.txt`) files:

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

The script clones the repository into `~/.config/wikis/src`, installs dependencies with `bun install`, and creates a global symlink for the `wikis` command using Bun's `link` feature. This leverages the `package.json` `bin` field (`"wikis": "cli/main.ts"`), placing the executable in the global PATH without requiring npm or Homebrew.

Execute in a terminal:

```bash
curl -fsSL https://wikis.fyi/public/install.sh | sh
```

The script executes these steps:

1. Detects Bun; downloads and installs from bun.sh if missing.
2. Clones or updates the repository into `~/.config/wikis/src`.
3. Runs `bun install` for dependencies.
4. Executes `bun link` for global `wikis` access.

This isolates the installation in `~/.config/wikis`, avoiding global or project pollution. Updates run via `wikis update`, which pulls changes and reinstalls dependencies. See [cli-commands.md](cli-commands.md) for CLI details.

## Verifying the Installation

Verify by checking help output, which lists commands and confirms PATH integration:

```bash
wikis --help
```

Success shows commands like `wikis init` (project setup) and `wikis serve` (local server). Failures often indicate PATH issues; restart the shell or check `~/.config/wikis`.

## Self-Hosting the Server

For local operation without the hosted service at wikis.fyi, run `wikis serve` post-CLI installation. This starts the full Elysia server, binding via environment variables or `config/wikis.yml`:

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

Defaults to `http://0.0.0.0:3000`, overridable by `PORT`/`HOST` or config. A health endpoint confirms readiness:

```bash
curl http://localhost:3000/health
```

Expected: `{"ok":true}`.

LLM-driven generation activates with API keys from environment or config—the first available provider enables:

```typescript
export const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY || (rawConfig.anthropic_api_key as string);
export const OPENAI_API_KEY = process.env.OPENAI_API_KEY || (rawConfig.openai_api_key as string);
export const XAI_API_KEY = process.env.XAI_API_KEY || (rawConfig.xai_api_key as string);
export const GEMINI_API_KEY = process.env.GEMINI_API_KEY || (rawConfig.gemini_api_key as string);
```

Embeddings use Ollama at `http://localhost:11434` (via `OLLAMA_URL`/`OLLAMA_EMBED_MODEL`). See [search-features.md](search-features.md) for hybrid FTS5 + vector details and [ai-generation.md](ai-generation.md) for agent logic.

The CLI daemon targets the local instance by setting `api_url: http://localhost:3000/api` in `~/.config/wikis/config.yml`. Refer to [self-hosting.md](self-hosting.md) for setup, [architecture.md](architecture.md) for components, [configuration.md](configuration.md) for options, [syncing-mechanism.md](syncing-mechanism.md) for sync, and [cli-commands.md](cli-commands.md) for daemon control via `wikis start`.

## Next Steps

Run `wikis init` in a project to create `wiki/config.yml` and trigger initial generation. See [cli-commands.md](cli-commands.md) for commands, [configuration.md](configuration.md) for globs/options, and [syncing-mechanism.md](syncing-mechanism.md) for watching/sync.