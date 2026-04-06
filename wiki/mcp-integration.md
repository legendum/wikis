# MCP Integration

## Overview

MCP (Model Context Protocol) exposes wiki functionalities as standardized tools for AI agents. The wikis project implements an MCP server at the `/api/mcp` HTTP endpoint, providing a JSON-RPC 2.0 interface over POST requests. This enables MCP-compliant agents, such as those from Anthropic, to discover and call tools for listing wikis, searching content, reading pages, and listing pages without custom HTTP integrations. The server supports both authenticated user-specific wikis and public wikis, selecting the appropriate database based on a Bearer token in the `Authorization` header or falling back to the public database.

This design uses JSON-RPC for compatibility across MCP ecosystems and mounts seamlessly under the API routes in [architecture.md](architecture.md). Tools leverage core components including hybrid search from [search-features.md](search-features.md), file storage from [database-storage.md](database-storage.md), and authentication from [authentication.md](authentication.md), ensuring agents access current, searchable wiki data.

## MCP Server Endpoint

The MCP server processes POST requests to `/api/mcp`. It parses the JSON-RPC body, authenticates via Bearer token if present, selects the database (user or public), and dispatches to method handlers. Supported methods include `initialize`, `notifications/initialized`, `tools/list`, and `tools/call`.

From `src/routes/api.ts`:

```typescript
.post("/mcp", async ({ body, headers }) => {
  // MCP supports both authenticated (user wikis) and public wikis
  const token = extractBearerToken(headers.authorization);
  let db: Database;
  if (token) {
    const user = validateAccountKey(token);
    if (user) {
      db = getUserDb(user.id);
    }
  }
  // Fall back to public DB
  if (!db) db = getPublicDb();

  const result = await handleMcpRequest(db, body as Record<string, unknown>);
  return result;
});
```

The `handleMcpRequest` function in `src/lib/mcp.ts` routes requests:

```typescript
export async function handleMcpRequest(
  db: Database,
  body: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const { method, id, params } = body as {
    method: string;
    id: unknown;
    params?: Record<string, unknown>;
  };

  switch (method) {
    case 'initialize':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'wikis.fyi', version: '1.0.0' },
        },
      };