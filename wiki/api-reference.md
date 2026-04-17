# API Reference

The "wikis" project exposes a JSON web API under the `/api` prefix for managing AI-generated wikis. Endpoints handle file synchronization, source ingestion for regeneration, content search, wiki CRUD operations, usage tracking, manual rebuilds, authentication via Legendum account keys, and MCP integration. The API uses the Elysia framework for routing, defined in `src/routes/api.ts` and mounted via `app.use(apiRoutes)` in `src/server.ts`. All endpoints use JSON request and response bodies. User-specific operations require `Authorization: Bearer <token>` where `<token>` is a Legendum account key starting with `lak_`. The `authGuard` middleware validates tokens against the global user registry database and provides access to the user's private per-user SQLite database [architecture.md](architecture.md).

A health check exists at `/health` (outside `/api`), returning `{ "ok": true }`.

## Authentication

Bearer tokens from Legendum account keys provide access to private wikis. Register keys via `POST /api/login`, which validates against the Legendum API (if not self-hosted) before storing a local SHA-256 hash in the global `account_keys` table. The `authGuard` isolates operations to per-user databases [authentication.md](authentication.md). In self-hosted mode [self-hosting.md](self-hosting.md), authentication is bypassed, and all requests use a single local user database.

```typescript
function authGuard(headers: Record<string, string | undefined>) {
  if (isSelfHosted()) {
    ensureLocalUser();
    return {
      user: {
        id: LOCAL_USER_ID,
        email: LOCAL_USER_EMAIL,
        legendum_token: null,
      },
      db: getUserDb(LOCAL_USER_ID),
    };
  }

  const token = extractBearerToken(headers.authorization);
  if (!token) throw new Error("Missing Authorization header");

  const user = validateAccountKey(token);
  if (!user) throw new Error("Invalid account key");

  return { user, db: getUserDb(user.id) };
}
```

All responses follow `{ "ok": boolean, "data"?: any, "error"?: string, "message"?: string }`. Common errors: `wiki_not_found`, `missing_query`, `internal_error`, `invalid_key`. Wikis auto-create on-demand. Endpoints interact with storage [syncing-mechanism.md](syncing-mechanism.md), search indexes [search-features.md](search-features.md), and AI generation [ai-generation.md](ai-generation.md).

## Endpoints

### Sync Endpoints

Manifest-based synchronization for wiki content [syncing-mechanism.md](syncing-mechanism.md). Wikis auto-create if absent.

#### POST /api/sync

Diffs local/remote manifests to compute sync plan.

**Request:**
```json
{
  "wiki": "string",
  "files": { "path": { "hash": "string", "modified": "ISO-8601" } }
}
```

**Response:**
```json
{ "ok": true, "data": { "push": ["path"], "pull": ["path"], "conflicts": ["path"], "deleteLocal": ["path"], "deleteRemote": ["path"] } }
```

#### POST /api/push

Upserts files to `wiki_files`; indexes into `wiki_chunks` (no embeddings).

**Request:**
```json
{
  "wiki": "string",
  "files": [{ "path": "string", "content": "string", "modified": "ISO-8601" }]
}
```

**Response:**
```json
{ "ok": true, "data": { "pushed": number } }
```

#### POST /api/pull

Fetches files by paths.

**Request:**
```json
{
  "wiki": "string",
  "paths": ["string"]
}
```

**Response:**
```json
{
  "ok": true,
  "data": {
    "files": [{ "path": "string", "content": "string", "hash": "string", "modified": "ISO-8601" }]
  }
}
```

### Source Ingestion

#### POST /api/sources

Stores sources in `source_files` (skips unchanged via hash); queues regeneration if changed or initial build needed.

**Request:**
```json
{
  "wiki": "string",
  "files": [{ "path": "string", "content": "string" }]
}
```

**Response:**
```json
{
  "ok": true,
  "data": { "files": number, "changed": number, "queued_regeneration": boolean }
}
```

### Search

#### GET /api/search/:wiki

Hybrid FTS5 + RAG re-ranking [search-features.md](search-features.md). Query: `?q=string` (req), `?limit=number`.

**Response:**
```json
{
  "ok": true,
  "data": {
    "results": [{ "path": "string", "chunk": "string", "score": number }]
  }
}
```

### Wiki Management

#### GET /api/wikis

Lists wikis.

**Response:**
```json
{
  "ok": true,
  "data": {
    "wikis": [{ "id": number, "name": "string", "visibility": "private|public", "created_at": "ISO-8601" }]
  }
}
```

#### DELETE /api/wikis/:name

Cascades delete.

**Response:** `{ "ok": true }`

#### DELETE /api/wikis/:name/pages/:path

Marks deleted; deletes chunks; async rebuilds index.

**Response:** `{ "ok": true, "data": { "deleted": "path.md" } }`

### Usage and Rebuild

#### GET /api/usage

Monthly stats from `events`.

**Response:**
```json
{
  "ok": true,
  "data": {
    "period": "YYYY-MM",
    "wikis": number,
    "source_pushes": number,
    "wiki_updates": number,
    "credits_used": number
  }
}
```

#### POST /api/rebuild

Async agent rebuild.

**Request:**
```json
{ "wiki": "string", "force": boolean }
```

**Response:** `{ "ok": true, "data": { "message": "Rebuild started" } }`

### Login

#### POST /api/login

Registers/validates key.

**Request:**
```json
{ "key": "lak_..." }
```

**Response:** `{ "ok": true, "data": { "email": "string" } }`

### MCP Server

#### POST /api/mcp

JSON-RPC 2.0 MCP server for AI agents. Supports user DB (via auth), local user (self-hosted), or public DB fallback. Methods: `initialize`, `tools/list`, `tools/call` (`notifications/initialized` acked).

**initialize Response:**
```json
{
  "jsonrpc": "2.0",
  "id": any,
  "result": {
    "protocolVersion": "2024-11-05",
    "capabilities": { "tools": {} },
    "serverInfo": { "name": "wikis.fyi", "version": "1.0.0" }
  }
}
```

**tools/list Response:**
```json
{
  "jsonrpc": "2.0",
  "id": any,
  "result": { "tools": [toolSchemas] }
}
```

**Tools** (discovered via `tools/list`):

| Name | Description | Input Schema |
|------|-------------|-------------|
| `list_wikis` | List wikis. | `{ type: "object", properties: {} }` |
| `search_wiki` | Hybrid search. | `{ type: "object", properties: { wiki: {type:"string"}, query: {type:"string"}, limit: {type:"number"} }, required: ["wiki","query"] }` |
| `read_page` | Full page + updates. | `{ type: "object", properties: { wiki: {type:"string"}, page: {type:"string"} }, required: ["wiki","page"] }` |
| `list_pages` | List `.md` pages. | `{ type: "object", properties: { wiki: {type:"string"} }, required: ["wiki"] }` |

**tools/call Request Example:**
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "search_wiki",
    "arguments": { "wiki": "depends", "query": "sync", "limit": 5 }
  }
}
```

**tools/call Response:**
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "content": [{ "type": "text", "text": "1. **sync** (score: 0.95)\n   ...\n\n2. **api** ..." }],
    "isError": false
  }
}
```

Errors: `{ "jsonrpc": "2.0", "id": any, "error": { "code": -32601, "message": "string" } }`. Uses `search` [search-features.md](search-features.md), `getFile`/`listFiles`/`getPageUpdates` [database-storage.md](database-storage.md).