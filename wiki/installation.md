# Installation

The "wikis" project provides a CLI tool for managing personal AI-generated wikis. This page outlines the steps to install and set up the CLI, enabling users to watch project files, generate wiki pages, and sync with a server. The process emphasizes simplicity and automation through a shell script that manages dependencies, including the Bun runtime, to ensure broad compatibility across macOS, Linux, and WSL with minimal user intervention.

## Prerequisites

The CLI requires a Unix-like shell, such as Bash or Zsh, as the installation script employs shell commands for environment detection and setup. Bun serves as the primary runtime dependency, powering the CLI and server due to its high performance in executing TypeScript code and managing packages relative to Node.js. The installation script automatically detects and installs Bun if it is absent.

## Installation Steps

Installation proceeds via a single command that retrieves a shell script from the hosted public directory. The server serves static files from the `PUBLIC_DIR` at `/public/*`, handling content types appropriately for markdown (`.md`) and text (`.txt`) files:

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

This script clones the repository, installs dependencies, and establishes a global symlink for the `wikis` command via Bun's `link` feature, which utilizes the `package.json` `bin` field (`"wikis": "cli/main.ts"`). The curl-pipe-sh pattern facilitates one-command deployment without prerequisites such as npm or Homebrew.

Execute the following in a terminal:

```bash
curl -fsSL https://wikis.fyi/public/install.sh | sh
```

The script performs these steps:

1. Detects Bun installation; fetches and installs it if missing.
2. Clones or updates the repository into `~/.config/wikis/src`.
3. Executes `bun install` to resolve dependencies.
4. Runs `bun link` to create a symlink to `wikis` in the global PATH.

This design isolates the project within the user configuration directory (`~/.config/wikis`), preventing pollution of global or project-specific spaces. Updates occur via `wikis update`, which pulls the latest changes and reinstalls dependencies. See [cli-commands.md](cli-commands.md) for details on CLI operations.

## Verifying the Installation

Verify functionality by displaying the help output, which enumerates available commands and confirms PATH integration.

```bash
wikis --help
```

Successful output lists commands such as `wikis init` for project initialization and `wikis serve` for local server hosting. Failure typically stems from PATH issues; restart the shell or inspect `~/.config/wikis`.

## Self-Hosting the Server

For fully local operation without reliance on the hosted service at wikis.fyi, execute `wikis serve` after CLI installation. This launches the complete Elysia server, which derives its bind address from environment variables or `config/wikis.yml`:

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

The server binds to `http://0.0.0.0:3000` by default (overridable via `PORT` and `HOST` environment variables or `config/wikis.yml`). A health check endpoint confirms readiness:

```bash
curl http://localhost:3000/health
```

Expected response: `{"ok":true}`.

The server supports LLM-driven wiki generation when API keys are provided via environment variables—the first detected provider activates:

```typescript
export const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY || (rawConfig.anthropic_api_key as string);
export const OPENAI_API_KEY = process.env.OPENAI_API_KEY || (rawConfig.openai_api_key as string);
export const XAI_API_KEY = process.env.XAI_API_KEY || (rawConfig.xai_api_key as string);
export const GEMINI_API_KEY = process.env.GEMINI_API_KEY || (rawConfig.gemini_api_key as string);
```

Embeddings for search utilize Ollama at `http://localhost:11434` (configurable via `OLLAMA_URL` and `OLLAMA_EMBED_MODEL`). See [search-features.md](search-features.md) for hybrid FTS5 + vector search details and [ai-generation.md](ai-generation.md) for agent behavior.

The CLI daemon connects to the local instance by configuring `api_url: http://localhost:3000/api` in `~/.config/wikis/config.yml`. See [self-hosting.md](self-hosting.md) for detailed setup, [architecture.md](architecture.md) for component interactions, [configuration.md](configuration.md) for tuning, [syncing-mechanism.md](syncing-mechanism.md) for bi-directional synchronization, and [cli-commands.md](cli-commands.md) for daemon management via `wikis start`.

## Next Steps

Initialize a wiki within a project directory using `wikis init`, which generates `wiki/config.yml` and initiates the first generation cycle. Refer to [cli-commands.md](cli-commands.md) for full command details, [configuration.md](configuration.md) for source globs and options, and [syncing-mechanism.md](syncing-mechanism.md) for daemon watching and bi-directional synchronization via `wikis start`.