# API Reference

The "wikis" project exposes a JSON web API under the `/api` prefix for managing AI-generated wikis. Endpoints support file synchronization, source ingestion for regeneration, content search, wiki CRUD operations, usage tracking, manual rebuilds, authentication via Legendum account keys, and MCP integration. The API uses the Elysia framework for routing, with modular definitions in `src/routes/api.ts` mounted via `app.use(apiRoutes)` in `src/server.ts`. All endpoints use JSON request and response bodies. User-specific operations require `Authorization: Bearer <token>` where `<token>` is a Legendum account key starting with `lak_`. The `authGuard` middleware validates tokens against the global user registry database and provides access to the user's private per-user SQLite database.

A health check endpoint exists at `/health` (outside `/api`), returning `{ "ok": true }`.

## Overview

The API integrates with per-user SQLite databases for private wikis and a global database for user registry and authentication, as detailed in [Architecture](architecture.md) and [Database Storage](database-storage.md). Most endpoints apply the `authGuard` middleware:

```typescript
function authGuard(headers: Record<string, string | undefined>) {
  const token = extractBearerToken(headers.authorization);
  if (!token) throw new Error("Missing Authorization header");

  const user = validateAccountKey(token);
  if (!user) throw new Error("Invalid account key");

  return { user, db: getUserDb(user.id) };
}
```

This middleware extracts the bearer token, validates its hash against stored keys in the global database, and returns the user record alongside a handle to their per-user database. The design supports both hosted mode (initial Legendum API validation during key registration) and self-hosted mode ([Self-Hosting](self-hosting.md), [Authentication](authentication.md)), where keys are stored locally as SHA-256 hashes after optional remote validation.

Public endpoints like `POST /api/mcp` use a shared public database if no valid token is provided. Wikis create on-demand during sync or source operations.

Elysia enables the shared `/api` prefix:

```typescript
export const apiRoutes = new Elysia({ prefix: '/api' })
  // ... endpoints
```

Responses follow `{ "ok": boolean, "data"?: any, "error"?: string, "message"?: string }`. Common errors include `wiki_not_found`, `missing_query`, `internal_error`, and `invalid_key`.

Endpoints interact with storage ([Syncing Mechanism](syncing-mechanism.md)), search indexes ([Search Features](search-features.md)), and AI generation ([AI Generation](ai-generation.md)). They power CLI tools ([CLI Commands](cli-commands.md)).

## Authentication

Bearer tokens from Legendum account keys provide access. Register keys via `POST /api/login`, which validates against Legendum API (if configured) before storing a local hash. The `authGuard` isolates operations to per-user databases.

## Endpoints

### Sync Endpoints

Handle manifest-based file synchronization. Wikis auto-create if absent.

- **POST /api/sync**

  Computes a sync plan by diffing local and remote manifests. Wikis create if missing.

  Request body:
  ```json
  {
    "wiki": "string",
    "files": {} // Manifest object ([Syncing Mechanism](syncing-mechanism.md))
  }
  ```

  Response:
  ```json
  { "ok": true, "data": {} } // Sync plan
  ```

- **POST /api/push**

  Upserts files to `wiki_files`, updates manifests, and indexes content in `wiki_chunks` (without embeddings).

  Request body:
  ```json
  {
    "wiki": "string",
    "files": [
      { "path": "string", "content": "string", "modified": "string" }
    ]
  }
  ```

  Response:
  ```json
  { "ok": true, "data": { "pushed": number } }
  ```
  Or `{ "ok": false, "error": "wiki_not_found" }`.

- **POST /api/pull**

  Fetches files by paths from `wiki_files`.

  Request body:
  ```json
  {
    "wiki": "string",
    "paths": ["string"]
  }
  ```

  Response:
  ```json
  {
    "ok": true,
    "data": {
      "files": [
        { "path": "string", "content": "string", "hash": "string", "modified": "string" }
      ]
    }
  }
  ```
  Or `{ "ok": false, "error": "wiki_not_found" }`.

### Source Ingestion Endpoints

Ingest source files into `source_files`, detect changes via content hash, and schedule regeneration.

- **POST /api/sources**

  Stores sources with hashes; skips unchanged files (no `modified_at` update). Queues regeneration if sources changed or initial build needed (wiki pages absent despite sources). Debounces if pages exist already. Uses user's `legendum_token` for agent config.

  Request body:
  ```json
  {
    "wiki": "string",
    "files": [{ "path": "string", "content": "string" }]
  }
  ```

  Response:
  ```json
  {
    "ok": true,
    "data": {
      "files": number,
      "changed": number,
      "queued_regeneration": boolean
    }
  }
  ```
  Or `{ "ok": false, "error": "wiki_not_found|internal_error" }`.

### Search Endpoints

Performs hybrid search: FTS5 keyword matching with optional vector re-ranking ([Search Features](search-features.md)).

- **GET /api/search/:wiki**

  Query params: `q` (required), `limit` (optional).

  Response:
  ```json
  {
    "ok": true,
    "data": {
      "results": [
        { "path": "string", "chunk": "string", "score": number }
      ]
    }
  }
  ```
  Errors: `{ "ok": false, "error": "missing_query|wiki_not_found" }` (`missing_query` includes `message: "?q= is required"`).

### Wiki Management Endpoints

CRUD operations on wikis and pages.

- **GET /api/wikis**

  Lists user's wikis, ordered by name.

  Response:
  ```json
  {
    "ok": true,
    "data": {
      "wikis": [
        { "id": number, "name": "string", "visibility": "private|public", "created_at": "string" }
      ]
    }
  }
  ```

- **DELETE /api/wikis/:name**

  Cascades deletion of `wiki_chunks`, `source_files`, `wiki_files`, `events`, and `wikis` tables.

  Response: `{ "ok": true }` or `{ "ok": false, "error": "wiki_not_found" }`.

- **DELETE /api/wikis/:name/pages/:path**

  Marks page as `deleted=TRUE` in `wiki_files` (preserves regeneration skip), deletes `wiki_chunks`, and triggers asynchronous index rebuild via agent (omits deleted page from `index.md`).

  Response: `{ "ok": true, "data": { "deleted": "path.md" } }` or `{ "ok": false, "error": "wiki_not_found" }`.

### Usage and Rebuild Endpoints

- **GET /api/usage**

  Reports total wiki count and monthly event stats (source pushes, wiki updates, credits used) from the 1st of the current month.

  Response:
  ```json
  {
    "ok": true,
    "data": {
      "period": "string", // YYYY-MM
      "wikis": number,
      "source_pushes": number,
      "wiki_updates": number,
      "credits_used": number
    }
  }
  ```

- **POST /api/rebuild**

  Queues background agent rebuild (15+ minutes delay possible).

  Request body:
  ```json
  { "wiki": "string", "force": boolean }
  ```

  Response: `{ "ok": true, "data": { "message": "Rebuild started" } }` or `{ "ok": false, "error": "wiki_not_found" }`.

### Other Endpoints

- **POST /api/login**

  Registers or validates account key (validates against Legendum API if unregistered).

  Request body: `{ "key": "lak_..." }`

  Response: `{ "ok": true, "data": { "email": "string" } }` or `{ "ok": false, "error": "invalid_key", "message": "string" }`.

- **POST /api/mcp**

  Processes MCP requests ([MCP Integration](mcp-integration.md)); uses authenticated user DB or falls back to public DB.

For server setup, see [Installation](installation.md) and [Configuration](configuration.md).