# Self-Hosting

Self-hosting runs the full wikis.fyi service on a local machine. The Elysia server handles AI-powered wiki generation, source ingestion, search, and dynamic web serving using SQLite databases for content and metadata. No connections occur to the remote wikis.fyi instance. Users provide LLM API keys through environment variables for generation tasks. Local Ollama generates embeddings for search. Authentication supports optional local account keys stored as hashes in the global database. Self-hosting suits privacy-focused setups, development, and offline operation.

## Overview

The codebase operates identically in hosted and self-hosted modes. Users start the server with `wikis serve`, which binds to `http://0.0.0.0:3000` by default. The Elysia app exposes identical API routes, agent logic, and search functionality as the hosted service. LLM providers detect automatically from environment variables, with no billing applied.

Components integrate as follows:

- **Web Server**: Serves static assets from `public/` and dynamic wiki pages or search results from SQLite via web and API routes.
- **API Endpoints**: Manage source ingestion (`POST /api/sources`), wiki synchronization (`POST /api/sync`, `/push`, `/pull`), search (`GET /api/search/:wiki`), and wiki operations.
- **Agent**: Employs local LLMs to analyze sources and generate or update wiki pages. See [ai-generation](ai-generation.md).
- **Daemon**: Launches via `wikis start`, monitors sources with content hashing, pushes changes to the local API, and synchronizes the local `wiki/` filesystem.

Wiki content stores in SQLite (`wiki_files.content`), with the daemon maintaining a mirrored copy in the local `wiki/` filesystem through manifest-based synchronization. Metadata including hashes and timestamps tracks changes in SQLite. Search relies on local Ollama.

## Setting Up Self-Hosting

Install the CLI globally, configure LLM keys and Ollama, then launch the server and daemon.

### Installation

The installation script deploys Bun and links the CLI:

```bash
curl -fsSL https://wikis.fyi/install.sh | sh
```

Initialize a wiki in a project directory:

```bash
wikis init
```

This generates `wiki/config.yml` and registers the project with the daemon.

### Environment Variables

The server selects the first available LLM provider:

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

Configure one key (absence of `LEGENDUM_API_KEY` activates self-hosting):

```bash
export OPENAI_API_KEY=sk-...          # OpenAI (default: gpt-5-mini)
export CLAUDE_API_KEY=sk-ant-...      # Anthropic (default: claude-haiku-4-5)
export XAI_API_KEY=xai-...            # xAI/Grok (default: grok-4-1-fast-reasoning)
export GEMINI_API_KEY=...             # Google Gemini (default: gemini-3.1-flash-lite-preview)
```

For embeddings, Ollama runs locally:

```bash
export OLLAMA_URL=http://localhost:11434
export OLLAMA_EMBED_MODEL=all-minilm
```

Launch the server:

```bash
wikis serve
```

Output indicates `wikis.fyi running at http://0.0.0.0:3000`. Wiki pages render at `http://localhost:3000/{wiki}/{page}` (HTML) or `http://localhost:3000/{wiki}/{page}.md` (raw Markdown from database).

In a separate terminal, start the daemon:

```bash
wikis start
```

### Authentication

Local account keys enable optional authentication. The CLI supports local keys stored hashed in `data/wikis.db` (global database). API routes such as `/api/sources` apply `authGuard`:

```typescript
// From src/routes/api.ts
function authGuard(headers: Record<string, string | undefined>) {
  const token = extractBearerToken(headers.authorization);
  if (!token) throw new Error("Missing Authorization header");

  const user = validateAccountKey(token);
  if (!user) throw new Error("Invalid account key");

  return { user, db: getUserDb(user.id) };
}
```

`validateAccountKey` verifies against local hashes without remote calls. Endpoints like `/mcp` fallback to the public database (`data/public.db`) without authentication.

## Configuration

YAML files control behavior. See [configuration](configuration.md).

### Global Configuration

Modify `~/.config/wikis/config.yml` to direct the daemon locally:

```yaml
api_url: http://localhost:3000/api
account_key: lak_local123...  # Optional local key (hashed)
```

### Wiki Configuration

`wiki/config.yml` specifies sources:

```yaml
name: my-project
sources:
  - src/**/*.ts
  - docs/**/*.md
exclude:
  - node_modules/**
```

Source modifications trigger daemon pushes to `/api/sources`.

## How It Works

The daemon, server, and agent form a closed loop. The daemon pushes source diffs to `/api/sources`; the server stores them, triggers the agent on changes, and serves content. The daemon synchronizes local `wiki/` with the server database via `/api/sync`.

### Component Integration

- **Daemon (`wikis start`)**: Hashes sources, pushes changes to local `/api/sources`.
- **Web Server (`wikis serve`)**: Elysia app serves static assets:

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

  Dynamic wiki pages serve from the database via web routes (HTML or raw `.md`).
- **API Routes**: `/api/sources` computes hashes, stores changes in `source_files`, and queues regeneration:

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

  Regeneration triggers on changes or empty `wiki_files`.
- **AI Generation**: `runAgent` analyzes sources, plans sections, generates pages using environment LLMs (`legendumToken` null skips billing). See [ai-generation](ai-generation.md).
- **Search**: FTS5 virtual table plus Ollama RAG on `wiki_chunks`. See [search-features](search-features.md).
- **Synchronization**: Daemon employs `/api/sync` for manifest diffs, `/push` to upsert wiki content, `/pull` to fetch from database to `wiki/`. Last-write-wins handles conflicts. See [syncing-mechanism](syncing-mechanism.md).

## Differences from Hosted Mode

Self-hosting prioritizes local control:

| Aspect          | Hosted                          | Self-Hosted                          |
|-----------------|---------------------------------|--------------------------------------|
| **Billing**     | Legendum credits                | None (user LLM keys)                 |
| **Auth**        | Legendum OAuth/keys             | Local hashed keys (optional)         |
| **Storage**     | SQLite `wiki_files.content`     | SQLite content + synced `wiki/`      |
| **LLM Keys**    | Service-managed                 | User environment variables           |
| **Embeddings**  | Server Ollama                   | Local Ollama required                |
| **Data Privacy**| Server-hosted                   | Fully local                          |
| **Mode Detect** | `LEGENDUM_API_KEY` present      | Absent                               |

## Related Pages

- [Architecture](architecture.md)
- [Configuration](configuration.md)
- [AI Generation](ai-generation.md)
- [Search Features](search-features.md)
- [Syncing Mechanism](syncing-mechanism.md)