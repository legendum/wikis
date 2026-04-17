# Self-Hosting

Self-hosting deploys the full wikis.fyi service on a local machine. The Elysia server manages AI-powered wiki generation, source ingestion, search, and dynamic web serving using SQLite databases for content and metadata. No outbound connections occur to the remote wikis.fyi service. Users supply LLM API keys via environment variables to power generation tasks. Local Ollama generates embeddings for search. Optional authentication uses locally generated account keys, stored as hashes in the global database `data/wikis.db`. Self-hosting enables privacy-focused operation, local development, and fully offline workflows once initial setup completes.

## Overview

The codebase functions identically in hosted and self-hosted modes, with mode detection based on the absence of `LEGENDUM_API_KEY`. The `wikis serve` command launches the server, binding to `http://0.0.0.0:3000` by default. The Elysia application exposes the same API routes, agent logic, and search capabilities as the hosted service. LLM providers auto-detect from environment variables, bypassing all billing logic since `legendum_token` remains `null`.

Key components integrate as follows:

- **Web Server**: Serves static assets from `public/` and dynamic wiki pages or search results from SQLite databases via web and API routes. Static files receive appropriate content types based on extensions.

  ```typescript
  // From src/server.ts
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

- **API Endpoints**: Handle source ingestion (`POST /api/sources`), wiki synchronization (`POST /api/sync`, `/push`, `/pull`), search (`GET /api/search/:wiki`), and wiki management. See [api-reference.md](api-reference.md).
- **Agent**: Leverages local LLMs to analyze sources, plan sections, and generate or update wiki pages. See [ai-generation.md](ai-generation.md).
- **Daemon**: Invoked via `wikis start`, monitors sources using content hashing, pushes changes to the local API endpoints, and synchronizes the local `wiki/` filesystem.

Wiki content persists in SQLite (`wiki_files.content`), with the daemon maintaining a filesystem mirror in `wiki/` via manifest-based synchronization. Metadata tables track hashes and timestamps for change detection. Search uses local FTS5 tables augmented by Ollama embeddings. See [search-features.md](search-features.md) and [database-storage.md](database-storage.md).

## Setting Up Self-Hosting

Install the CLI globally, configure LLM keys and Ollama, then start the server and daemon.

### Installation

The installation script installs Bun and links the CLI:

```bash
curl -fsSL https://wikis.fyi/install.sh | sh
```

Initialize a wiki in the project directory:

```bash
wikis init
```

This creates `wiki/config.yml` and registers the project with the daemon. See [installation.md](cli-commands.md) and [cli-commands.md](cli-commands.md).

### Environment Variables

Self-hosting activates when `LEGENDUM_API_KEY` is absent. The server detects the first available LLM provider:

```typescript
// From src/lib/ai.ts
function detectProvider(): Provider {
  if (process.env.XAI_API_KEY) return 'xai';
  if (process.env.OPENAI_API_KEY) return 'openai';
  if (process.env.GEMINI_API_KEY) return 'google';
  if (process.env.CLAUDE_API_KEY) return 'anthropic';
  throw new Error('No LLM API key configured...');
}
```

Set one provider key:

```bash
export XAI_API_KEY=xai-...       # xAI/Grok (default: grok-4-1-fast-reasoning)
export OPENAI_API_KEY=sk-...     # OpenAI (default: gpt-5-mini)
export GEMINI_API_KEY=...        # Google Gemini (default: gemini-3.1-flash-lite-preview)
export CLAUDE_API_KEY=sk-ant-... # Anthropic (default: claude-haiku-4-5)
```

Embeddings require local Ollama:

```bash
export OLLAMA_URL=http://localhost:11434
export OLLAMA_EMBED_MODEL=all-minilm
```

Start the server:

```bash
wikis serve
```

The console logs `wikis.fyi running at http://0.0.0.0:3000`. Access wiki pages at `http://localhost:3000/{wiki}/{page}` (HTML) or `http://localhost:3000/{wiki}/{page}.md` (raw Markdown from database).

In another terminal, launch the daemon:

```bash
wikis start
```

### Authentication

Self-hosting supports optional local authentication but defaults to no authentication required. The `authGuard` middleware detects self-hosted mode and assigns a single local user without token validation:

```typescript
// From src/routes/api.ts
function authGuard(headers: Record<string, string | undefined>) {
  // Self-hosted mode: no auth, single local user owns everything.
  if (isSelfHosted()) {
    ensureLocalUser();
    return {
      user: {
        id: LOCAL_USER_ID,
        email: LOCAL_USER_EMAIL,
        legendum_token: null as string | null,
      },
      db: getUserDb(LOCAL_USER_ID),
    };
  }
  // ... hosted mode logic
}
```

The local user (`LOCAL_USER_ID: 0`, `LOCAL_USER_EMAIL: 'local@example.com'`) owns all wikis. Account keys (prefixed `lak_...`) can hash and store in `data/wikis.db` for explicit auth. See [authentication.md](authentication.md). Endpoints like `/mcp` use the local user database or fall back to `data/public.db` if unauthenticated. See [mcp-integration.md](api-reference.md).

## Configuration

YAML configuration files govern behavior. See [configuration.md](configuration.md).

### Global Configuration

Edit `~/.config/wikis/config.yml` to target the local server:

```yaml
api_url: http://localhost:3000/api
account_key: lak_local123...  # Optional local key (hashed locally)
```

### Wiki Configuration

Each `wiki/config.yml` defines sources:

```yaml
name: my-project
sources:
  - src/**/*.ts
  - docs/**/*.md
exclude:
  - node_modules/**
```

Source changes trigger daemon pushes to `/api/sources`.

## How It Works

The daemon, server, and agent operate in a closed local loop. The daemon pushes source diffs to `/api/sources`; the server stores them, triggers agent regeneration on changes, and serves content. The daemon synchronizes `wiki/` with the database via `/api/sync`. See [syncing-mechanism.md](syncing-mechanism.md) and [architecture.md](architecture.md).

### Component Integration

- **Daemon (`wikis start`)**: Computes source hashes, pushes changes to local `/api/sources`.
- **Web Server (`wikis serve`)**: Elysia app with static and dynamic routes.
- **API Routes**: `/api/sources` detects changes via hashes and queues regeneration:

  ```typescript
  // From src/routes/api.ts /sources
  const hash = hashContent(file.content);
  const existing = db
    .prepare("SELECT hash FROM source_files WHERE wiki_id = ? AND path = ?")
    .get(wiki.id, file.path) as { hash: string } | null;

  if (existing?.hash === hash) continue;

  // INSERT ... ON CONFLICT UPDATE
  changed++;
  ```

  Regeneration triggers on changes or when `wiki_files` lacks pages.
- **AI Generation**: `runAgent` analyzes sources using local LLMs (`legendumToken` null skips billing). See [ai-generation.md](ai-generation.md).
- **Search**: FTS5 virtual tables plus Ollama RAG on `wiki_chunks`. See [search-features.md](search-features.md).
- **Synchronization**: Daemon uses `/api/sync` for diffs, `/push` for upserts, `/pull` for fetches. Last-write-wins resolves conflicts.

## Differences from Hosted Mode

Self-hosting emphasizes local autonomy:

| Aspect          | Hosted                          | Self-Hosted                          |
|-----------------|---------------------------------|--------------------------------------|
| **Billing**     | Legendum credits                | None (user LLM keys)                 |
| **Auth**        | Legendum OAuth/keys             | Local user (no token required; optional hashed keys) |
| **Storage**     | SQLite `wiki_files.content`     | SQLite + synced `wiki/` filesystem   |
| **LLM Keys**    | Service-managed                 | User environment variables           |
| **Embeddings**  | Server Ollama                   | Local Ollama required                |
| **Data Privacy**| Server-hosted                   | Fully local                          |
| **Mode Detect** | `LEGENDUM_API_KEY` present      | Absent                               |

## Related Pages

- [Architecture](architecture.md)
- [AI Generation](ai-generation.md)
- [Authentication](authentication.md)
- [Configuration](configuration.md)
- [Database Storage](database-storage.md)
- [MCP Integration](api-reference.md)
- [Search Features](search-features.md)
- [Syncing Mechanism](syncing-mechanism.md)