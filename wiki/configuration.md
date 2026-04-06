# Configuration

The "wikis" project employs YAML configuration files at three levels—global user settings, per-wiki parameters, and server operations—to support customization in both hosted and self-hosted deployments. Global settings manage authentication via `account_key` (a Legendum token, format `lak_...`) and sync endpoints (`api_url`) shared across wikis. Per-wiki configurations define `name`, ingestion `sources` and `exclude` globs, optional predefined `sections` for [AI generation](ai-generation.md), and billing overrides like `legendumToken` or `userHasOwnKey`. Server settings configure runtime aspects such as ports, embedding models via Ollama, search parameters, and quotas. Environment variables override sensitive values like API keys for security and portability.

Configurations integrate deeply with core components. The `WikiConfig` interface, defined in `src/lib/agent.ts`, drives the [AI generation](ai-generation.md) agent and [billing](architecture.md) logic:

```typescript
export interface WikiConfig {
  name: string;
  sections?: { name: string; description: string }[];
  /** Legendum token for billing. Null = no billing (self-hosted or own API key). */
  legendumToken?: string | null;
  /** Whether user provides their own LLM API key (no billing). */
  userHasOwnKey?: boolean;
}
```

During agent execution, `billedChat` evaluates billing needs with `config.legendumToken && shouldBill(!!config.userHasOwnKey)`, where `shouldBill` checks hosted mode (`IS_HOSTED`) and absence of user-provided keys. Server constants from `config/wikis.yml`, loaded in `src/lib/constants.ts`, inform the web server, [search features](search-features.md), and indexing:

```typescript
const configPath = resolve(CONFIG_DIR, "wikis.yml");
const rawConfig = existsSync(configPath)
  ? (yaml.load(readFileSync(configPath, "utf8")) as Record<string, unknown>)
  : {};

export const PORT = Number(process.env.PORT || rawConfig.port || 3000);
export const OLLAMA_URL = process.env.OLLAMA_URL || (rawConfig.ollama_url as string) || "http://localhost:11434";
// ... other derived constants like SEARCH_FTS_WEIGHT
```

## Overview

YAML provides human-readable, version-control-friendly configuration. Concerns separate as follows:

- **Global**: `~/.config/wikis/config.yml`—sets `account_key` for [authentication](authentication.md) and billing, and `api_url` for syncing.
- **Per-wiki**: `wiki/config.yml`—specifies `name`, `sources`, `exclude`, optional `sections`, and billing flags.
- **Server**: `config/wikis.yml`—defines ports, Ollama settings, search tuning (`search_fts_weight`, `search_chunk_size`), and quotas.

CLI commands like `wikis init` generate templates. The daemon auto-detects per-wiki changes to trigger [syncing](syncing-mechanism.md). Environment variables (e.g., `OPENAI_API_KEY`, `OLLAMA_URL`) take precedence for secrets. In hosted mode, `account_key` enables [authentication](authentication.md); self-hosted mode ([self-hosting.md](self-hosting.md)) skips billing if LLM keys (CLAUDE_API_KEY, etc.) are present, detected in priority order.

## Global Configuration

The global file `~/.config/wikis/config.yml` centralizes the Legendum `account_key` for [authentication](authentication.md) and billing across wikis, alongside `api_url` for the sync endpoint. The `wikis login` CLI generates and validates it. Self-hosting overrides `api_url` to `http://localhost:3300/api`. The daemon and CLI reload dynamically, mapping `account_key` to `WikiConfig.legendumToken`.

Example:

```yaml
account_key: lak_...            # Legendum account key for authentication and billing
api_url: https://wikis.fyi/api  # Server URL for syncing; override for self-hosted
```

## Per-Wiki Configuration

Each wiki's `wiki/config.yml` sets the `name` (for URLs like `wikis.fyi/{name}`), `sources` (globs for ingestion into [database storage](database-storage.md)), `exclude` (skip patterns), optional `sections` (predefined topics guiding agent planning), and billing overrides. The daemon indexes matching files into `source_files`, prompting [AI generation](ai-generation.md) on changes. `wikis init` scaffolds defaults targeting code/docs while excluding noise. Absent `sections` trigger dynamic planning from README and source tree via `planSections` in `agent.ts`.

Billing flags bypass charges in self-hosted setups: `legendumToken: null` or `userHasOwnKey: true` (assumes local LLM keys).

Example:

```yaml
name: my-project                # Wiki name for syncing and URLs
sources:
  - src/**/*.ts
  - docs/**/*.md
  - README.md
exclude:
  - node_modules/**
  - "*.db"
# Optional predefined sections for AI planning
# sections:
#   - name: Architecture
#     description: System design and components
# Billing overrides (self-hosted/local keys)
# legendumToken: null
# userHasOwnKey: true
```

The agent loads `WikiConfig` directly; the indexer uses `sources`/`exclude`.

## Server Configuration

`config/wikis.yml` tunes the server for ports, providers, search, and quotas. Loaded at startup into `src/lib/constants.ts` constants, with environment precedence (e.g., `PORT=3300`). Hosted mode requires `LEGENDUM_API_KEY`/`LEGENDUM_SECRET`; self-hosted detects LLM keys (CLAUDE, OpenAI, XAI, Gemini first) and skips billing via `IS_HOSTED`.

Ollama generates RAG embeddings ([search-features.md](search-features.md)); FTS5 weights (`search_fts_weight: 0.7`) balance keyword/vector scores.

Example:

```yaml
# Server
port: 3300
host: 0.0.0.0

# Ollama (embeddings)
ollama_url: http://localhost:11434
ollama_embed_model: all-minilm

# Search tuning
search_chunk_size: 512
search_chunk_overlap: 64
search_fts_weight: 0.7
search_vector_weight: 0.3
search_default_limit: 20

# LLM (self-hosted; first env/config key wins)
# openai_api_key: sk-...  # Or CLAUDE_API_KEY, etc.
```

`wikis serve` requires restart for changes. Integrates with [architecture](architecture.md) and [self-hosting](self-hosting.md).

## Public Wikis

Public wikis apply hardcoded defaults from `src/lib/public-wikis.ts`: `DEFAULT_SOURCES` (e.g., `src/**/*.ts`, `README.md`) and `DEFAULT_EXCLUDE` (e.g., `node_modules/**`). Overridable via `config/public-wikis.yml` for repo-specific globs/sections. No billing; agent runs with empty `sections` for dynamic planning. The server clones repos, indexes sources, and builds wikis periodically.

Example `config/public-wikis.yml`:

```yaml
wikis:
  - repo: https://github.com/legendum/depends.git
    name: depends
    sources:  # Optional override
      - src/**/*.ts
```

## Managing Configurations

Edit YAML manually for Git compatibility. Daemon/CLI auto-detect changes; `wikis sync` forces sync. Security prioritizes environment variables for keys; account keys hash in storage via `src/lib/auth.ts`. Global/per-wiki tokens enable hosted billing or local bypass per [authentication](authentication.md).

Configurations form a modular base, unifying agent execution, [database storage](database-storage.md), [search features](search-features.md), and server runtime for secure, adaptable deployments.