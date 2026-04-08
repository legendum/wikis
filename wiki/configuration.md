# Configuration

The "wikis" project uses YAML configuration files across three levels—global user settings, per-wiki parameters, and server operations—to enable customization for both hosted deployments at wikis.fyi and self-hosted instances. This layered approach separates user authentication and syncing (global), wiki-specific ingestion and generation rules (per-wiki), and runtime tuning (server). Environment variables override sensitive fields like API keys, prioritizing security and flexibility.

Configurations drive key components. The `WikiConfig` interface in [src/lib/agent.ts](ai-generation.md) informs the [AI generation](ai-generation.md) process and [billing](architecture.md) decisions:

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

During [AI generation](ai-generation.md), `billedChat` checks billing eligibility with `config.legendumToken && shouldBill(!!config.userHasOwnKey)`. The `shouldBill` function from [src/lib/billing.ts](architecture.md) returns true only in hosted mode (`IS_HOSTED`, set when `LEGENDUM_API_KEY` and `LEGENDUM_SECRET` exist) without user-provided keys.

Server constants load from `config/wikis.yml` in [src/lib/constants.ts](architecture.md), with environment precedence:

```typescript
const configPath = resolve(CONFIG_DIR, "wikis.yml");
const rawConfig = existsSync(configPath)
  ? (yaml.load(readFileSync(configPath, "utf8")) as Record<string, unknown>)
  : {};

export const PORT = Number(process.env.PORT || rawConfig.port || 3000);
export const OLLAMA_URL = process.env.OLLAMA_URL || (rawConfig.ollama_url as string) || "http://localhost:11434";
// Derived constants like SEARCH_FTS_WEIGHT, SEARCH_CHUNK_SIZE
```

These integrate with [search features](search-features.md), indexing, and the web server. CLI tools like `wikis init` generate templates, while the daemon detects per-wiki config changes to trigger [syncing](syncing-mechanism.md).

## Overview

YAML files offer human-readable, Git-friendly configuration. Separation of concerns includes:

- **Global**: `~/.config/wikis/config.yml`—holds `account_key` (Legendum token for [authentication](authentication.md) and billing) and `api_url` (sync endpoint).
- **Per-wiki**: `wiki/config.yml`—defines `name`, `sources`/`exclude` globs for [database storage](database-storage.md), optional `sections` for [AI generation](ai-generation.md), and billing overrides.
- **Server**: `config/wikis.yml`—sets ports, Ollama for embeddings, [search features](search-features.md) tuning (`search_fts_weight`, `search_chunk_size`), sync intervals, quotas, and costs.

Self-hosted mode ([self-hosting.md](self-hosting.md)) bypasses billing via local LLM keys (detected as `CLAUDE_API_KEY`, `OPENAI_API_KEY`, `XAI_API_KEY`, `GEMINI_API_KEY` in priority order). Public wikis use hardcoded defaults, overridable in `config/public-wikis.yml`.

## Global Configuration

The global file at `~/.config/wikis/config.yml` stores the Legendum `account_key` (format `lak_...`) for [authentication](authentication.md) across wikis and `api_url` for the sync endpoint (defaults to hosted service; override to `http://localhost:3300/api` for self-hosting). The `wikis login` CLI generates and stores it, hashing for security in [src/lib/auth.ts](authentication.md). Daemon and CLI reload dynamically.

Example:

```yaml
account_key: lak_...            # Legendum account key for authentication and billing
api_url: https://wikis.fyi/api  # Server URL for syncing; override for self-hosted
```

## Per-Wiki Configuration

Each wiki's `wiki/config.yml` specifies the `name` (used in URLs like `wikis.fyi/{name}`), `sources` (globs for files ingested into [database storage](database-storage.md)), `exclude` (patterns to skip), optional `sections` (predefined topics for [AI generation](ai-generation.md) planning), and billing overrides. The daemon indexes matching files into `source_files`, triggering agent runs on changes. Absent `sections` invoke dynamic planning via `planSections` in `agent.ts`, using README and source tree.

Billing overrides for self-hosted: `legendumToken: null` disables charges; `userHasOwnKey: true` assumes local LLM keys.

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
# Optional predefined sections
# sections:
#   - name: Architecture
#     description: System design and components
# Billing overrides (self-hosted/local keys)
# legendumToken: null
# userHasOwnKey: true
```

The [AI agent](ai-generation.md) loads `WikiConfig` directly; indexer applies `sources`/`exclude`.

## Server Configuration

`config/wikis.yml` configures runtime behavior, loaded into constants at startup with environment precedence (e.g., `PORT=3300`). Hosted mode activates via `LEGENDUM_API_KEY`/`LEGENDUM_SECRET`; self-hosted detects LLM keys first (Claude, OpenAI, xAI, Gemini) and skips billing.

Ollama powers RAG embeddings ([search-features.md](search-features.md)); FTS5 tuning balances keyword (`search_fts_weight: 0.7`) and vector scores.

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

# Source watching intervals (seconds)
source_check_min_interval: 300
source_check_max_interval: 1800
```

Changes require `wikis serve` restart. Integrates with [architecture](architecture.md) and [self-hosting](self-hosting.md).

## Public Wikis

Public wikis use defaults in [src/lib/public-wikis.ts](architecture.md): `DEFAULT_SOURCES` (`src/**/*.ts`, `README.md`, etc.) and `DEFAULT_EXCLUDE` (`node_modules/**`). Override via `config/public-wikis.yml` for custom globs/sections. No billing; empty `sections` enables dynamic planning. Server clones repos, indexes, and runs agent periodically.

Example `config/public-wikis.yml`:

```yaml
wikis:
  - repo: https://github.com/legendum/depends.git
    name: depends
    sources:  # Optional override
      - src/**/*.ts
```

## Managing Configurations

Edit YAML directly for version control. Daemon auto-reloads per-wiki changes; `wikis sync` forces updates. Environment variables secure keys; account keys hash in [database storage](database-storage.md) via `auth.ts`. Global/per-wiki tokens support hosted billing or local bypass per [authentication](authentication.md).

This modular system unifies [AI generation](ai-generation.md), [database storage](database-storage.md), [search features](search-features.md), and runtime for adaptable deployments.