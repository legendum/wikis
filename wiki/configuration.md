# Configuration

The "wikis" project employs YAML configuration files at three levels—global user settings, per-wiki parameters, and server operations—to support customization in both hosted deployments at wikis.fyi and self-hosted setups. This layered design isolates user authentication and syncing (global), wiki-specific ingestion and generation rules (per-wiki), and runtime parameters (server). Environment variables take precedence over YAML for sensitive values like API keys, enhancing security and deployment flexibility.

Configurations power core components. The `WikiConfig` interface from [ai-generation.md](ai-generation.md) guides the [AI generation](ai-generation.md) process and [billing](architecture.md) logic:

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

In [AI generation](ai-generation.md), `billedChat` evaluates billing with `config.legendumToken && shouldBill(!!config.userHasOwnKey)`. The `shouldBill` function in [src/lib/billing.ts](architecture.md) returns true solely for hosted mode (when `LEGENDUM_API_KEY` and `LEGENDUM_SECRET` exist) without a user-provided key.

Server constants derive from `config/wikis.yml` via [src/lib/constants.ts](architecture.md), with environment overrides:

```typescript
const configPath = resolve(CONFIG_DIR, "wikis.yml");
const rawConfig = existsSync(configPath)
  ? (yaml.load(readFileSync(configPath, "utf8")) as Record<string, unknown>)
  : {};

export const PORT = Number(process.env.PORT || rawConfig.port || 3000);
export const HOST = String(process.env.HOST || rawConfig.host || "0.0.0.0");
export const OLLAMA_URL = process.env.OLLAMA_URL || (rawConfig.ollama_url as string) || "http://localhost:11434";
export const OLLAMA_EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL || (rawConfig.ollama_embed_model as string) || "all-minilm";
// Additional constants: SEARCH_FTS_WEIGHT, SEARCH_CHUNK_SIZE, SEARCH_VECTOR_WEIGHT, etc.
export const LEGENDUM_API_KEY = process.env.LEGENDUM_API_KEY || (rawConfig.legendum_api_key as string);
export const LEGENDUM_SECRET = process.env.LEGENDUM_SECRET || (rawConfig.legendum_secret as string);
export const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY || (rawConfig.anthropic_api_key as string);
export const OPENAI_API_KEY = process.env.OPENAI_API_KEY || (rawConfig.openai_api_key as string);
export const XAI_API_KEY = process.env.XAI_API_KEY || (rawConfig.xai_api_key as string);
export const GEMINI_API_KEY = process.env.GEMINI_API_KEY || (rawConfig.gemini_api_key as string);
```

These constants integrate with [search features](search-features.md), indexing, and the web server. CLI commands like `wikis init` produce template files, while the daemon monitors per-wiki config changes to initiate [syncing](syncing-mechanism.md) and re-indexing.

## Overview

YAML configurations provide a human-readable, version-control-friendly format. The separation of concerns encompasses:

- **Global**: `~/.config/wikis/config.yml`—contains `account_key` (Legendum token for [authentication](authentication.md) and billing) and `api_url` (sync endpoint).
- **Per-wiki**: `wiki/config.yml`—specifies `name`, `sources`/`exclude` globs for [database storage](database-storage.md), optional `sections` for [AI generation](ai-generation.md), and billing flags.
- **Server**: `config/wikis.yml`—configures ports, Ollama endpoints for embeddings, [search features](search-features.md) parameters (`search_fts_weight`, `search_chunk_size`, `search_vector_weight`), sync intervals, and logging.

Self-hosted mode ([self-hosting.md](self-hosting.md)) skips billing by detecting LLM API keys via environment variables in this order: `XAI_API_KEY` (xAI/Grok), `OPENAI_API_KEY` (OpenAI/GPT), `GEMINI_API_KEY` (Google/Gemini), `CLAUDE_API_KEY` (Anthropic/Claude). Public wikis apply hardcoded defaults, customizable via `config/public-wikis.yml`.

## Global Configuration

The global configuration resides at `~/.config/wikis/config.yml` and holds the Legendum `account_key` (prefixed `lak_...`) for [authentication](authentication.md) across wikis and `api_url` for the sync endpoint (defaults to the hosted service; override to `http://localhost:3300/api` for self-hosting). The `wikis login` CLI command generates and stores it, hashing the key for security in [src/lib/auth.ts](authentication.md). The daemon and CLI reload this file dynamically.

Example:

```yaml
account_key: lak_...            # Legendum account key for authentication and billing
api_url: https://wikis.fyi/api  # Server URL for syncing; override for self-hosted
```

## Per-Wiki Configuration

Each wiki's `wiki/config.yml` defines the `name` (for URLs like `wikis.fyi/{name}`), `sources` (globs matching files for ingestion into [database storage](database-storage.md)), `exclude` (skip patterns), optional `sections` (for [AI generation](ai-generation.md) structure), and billing overrides. The daemon indexes files matching these globs into `source_files`, triggering agent execution on modifications. Without `sections`, dynamic planning occurs via `planSections` in `agent.ts` (using README.md and the source tree); existing pages reuse as sections unless forced.

Billing overrides enable self-hosted bypass: `legendumToken: null` prevents charges; `userHasOwnKey: true` signals local LLM keys.

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

The [AI agent](ai-generation.md) parses `WikiConfig` directly; the indexer respects `sources`/`exclude`.

## Server Configuration

The `config/wikis.yml` file tunes server runtime, loaded into constants at startup with environment precedence (e.g., `PORT=3300`). Hosted mode enables via `LEGENDUM_API_KEY`/`LEGENDUM_SECRET`; self-hosted prioritizes LLM keys per detection order above, bypassing billing.

Ollama generates RAG embeddings ([search-features.md](search-features.md)); FTS5 parameters (`search_fts_weight: 0.7`, `search_vector_weight: 0.3`) balance keyword and vector relevance.

Example:

```yaml
# Server
port: 3300
host: 0.0.0.0

# Legendum (hosted mode)
# legendum_api_key: lpk_...
# legendum_secret: lsk_...
# legendum_base_url: https://legendum.co.uk

# LLM (self-hosted mode — first available per detection order)
# anthropic_api_key: sk-ant-...
# openai_api_key: sk-...
# xai_api_key: xai-...
# gemini_api_key: ...

# Ollama (embeddings)
ollama_url: http://localhost:11434
ollama_embed_model: all-minilm

# Search tuning
search_chunk_size: 512
search_chunk_overlap: 64
search_fts_weight: 0.7
search_vector_weight: 0.3
search_default_limit: 20

# Source watching intervals (seconds)
source_check_min_interval: 300
source_check_max_interval: 1800

# Logging
# log_level: info
```

Server restart follows changes. This feeds into [architecture](architecture.md) and [self-hosting](self-hosting.md).

## Public Wikis

Public wikis leverage defaults in [src/lib/public-wikis.ts](architecture.md): `DEFAULT_SOURCES` (`src/**/*.ts`, `src/**/*.js`, `lib/**/*.ts`, `lib/**/*.js`, `docs/**/*.md`, `config/**/*.yml`, `config/**/*.yaml`, `README.md`, `CLAUDE.md`) and `DEFAULT_EXCLUDE` (`node_modules/**`, `dist/**`, `.git/**`, `*.db`, `*.lock`, `bun.lock`). Empty `sections` triggers dynamic planning. Overrides occur in `config/public-wikis.yml`. The server clones repositories, indexes sources, and invokes the agent periodically. No billing applies.

Example `config/public-wikis.yml`:

```yaml
wikis:
  - repo: https://github.com/legendum/depends.git
    name: depends
    sources:  # Optional override
      - src/**/*.ts
```

## Managing Configurations

YAML files support direct editing under version control. The daemon auto-reloads per-wiki changes; `wikis sync` enforces updates. Environment variables secure API keys; account keys hash in [database storage](database-storage.md) through `auth.ts`. Global and per-wiki tokens accommodate hosted billing or local bypasses per [authentication](authentication.md).

This modular approach unifies [AI generation](ai-generation.md), [database storage](database-storage.md), [search features](search-features.md), and runtime operations across deployments.