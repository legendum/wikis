# wikis.fyi

**Personal AI-generated wikis**

wikis.fyi is a personal AI-generated wiki service. A background CLI (`wikis`) watches your project files, maintains a local `wiki/` folder of interlinked markdown pages, and syncs it to wikis.fyi for browsing and sharing. Login, linking, and billing are handled by Legendum.

Self-hostable: the same codebase runs at wikis.fyi and locally via `wikis serve`.

## Features

- **AI-Powered Wiki Generation**: LLMs read your project sources and automatically generate structured, interlinked markdown wiki pages
- **Local-First**: Wiki content lives in your local `wiki/` folder; only syncs to the cloud when you choose
- **Background Daemon**: Watches source files for changes and updates the wiki automatically
- **Search & Discovery**: Full-text search with RAG re-ranking for accurate results
- **Self-Hostable**: Run the full service locally with your own LLM keys
- **MCP Integration**: Expose wiki search as a tool for AI agents like Claude Code
- **Git-Aware**: Tracks changes using Git diffs for efficient updates

## Quick Start

### Install

```bash
curl -fsSL https://wikis.fyi/install.sh | sh
```

This installs Bun (if needed) and symlinks the `wikis` CLI globally.

### Initialize a Wiki

In any project directory:

```bash
wikis init
```

This creates a `wiki/` folder with configuration and starts building your first wiki pages.

### Browse Your Wiki

Start the web server:

```bash
wikis serve
```

Open http://localhost:3000 to browse your wiki.

## CLI Commands

| Command | Description |
|---------|-------------|
| `wikis init` | Initialize a wiki in the current project |
| `wikis serve` | Start the web server |
| `wikis start` | Start the background daemon |
| `wikis stop` | Stop the background daemon |
| `wikis status` | Show daemon and project status |
| `wikis sync` | Push sources and pull wiki pages |
| `wikis search <query>` | Search wiki pages |
| `wikis login` | Authenticate with Legendum |
| `wikis list` | List registered projects |
| `wikis remove` | Unregister the current project |

Run `wikis --help` for full usage.

## Project Structure

After running `wikis init`:

```
my-project/
  src/
  docs/
  README.md
  wiki/                         # Your AI-generated wiki
    config.yml                  # Wiki configuration
    index.md                    # Catalog of all pages
    log.md                      # Changelog
    architecture.md             # Generated wiki pages
    api-endpoints.md
    ...
```

## Configuration

### Wiki Config (`wiki/config.yml`)

```yaml
name: my-project                # Wiki name
sources:
  - src/**/*.ts
  - docs/**/*.md
  - README.md
exclude:
  - node_modules/**
  - "*.db"
```

### Global Config (`~/.config/wikis/config.yml`)

```yaml
account_key: lak_...            # Legendum account key
api_url: https://wikis.fyi/api  # Server URL
```

## Self-Hosting

Run locally with your own LLM keys:

```bash
# Set one of these environment variables
export OPENAI_API_KEY=sk-...
export CLAUDE_API_KEY=sk-ant-...
export XAI_API_KEY=xai-...

wikis serve
```

Default models:
- Grok: `grok-4-1-fast-reasoning`
- GPT: `gpt-5-mini`
- Gemini: `gemini-3.1-flash-lite-preview`
- Claude: `claude-haiku-4-5`

The daemon connects to your local server just like it would to wikis.fyi.

## Development

### Prerequisites

- [Bun](https://bun.sh/) runtime
- SQLite
- Ollama (for embeddings, optional)

### Setup

```bash
git clone https://github.com/your-org/wikis
cd wikis
bun install
```

### Run in Development

```bash
bun run dev  # Server with hot reload
bun test     # Run tests
```

### Environment Variables

```bash
# For hosted mode (billing active)
LEGENDUM_API_KEY=lpk_...
LEGENDUM_SECRET=lsk_...

# For self-hosted mode (user provides LLM keys)
OPENAI_API_KEY=sk-...
OLLAMA_URL=http://localhost:11434
```

## Billing

Uses Legendum credits (Ⱡ). Free tier: 500 source pushes, 100 LLM updates, 1 wiki per month.

Paid actions:
- Source push: 1Ⱡ per diff
- Wiki update: 5Ⱡ per LLM run
- Storage: 10Ⱡ per active wiki/month

## Architecture

- **Runtime**: Bun
- **Framework**: Elysia
- **Database**: SQLite (per-user)
- **Search**: FTS5 + RAG (Ollama embeddings)
- **Auth**: Legendum OAuth
- **Templating**: Eta (server-side HTML)

## Contributing

See [SPEC.md](docs/SPEC.md) for detailed architecture and design decisions.

## License

See [LICENSE](LICENSE) file.