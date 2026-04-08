# MCP Integration

## Overview

MCP (Model Context Protocol) provides a standardized JSON-RPC 2.0 interface that exposes wiki functionalities as tools for AI agents. The wikis project implements an MCP server at the `/api/mcp` HTTP endpoint via POST requests. This allows MCP-compliant agents, such as those from Anthropic, to discover available tools and invoke them without custom HTTP client code. Tools enable listing wikis, searching content with hybrid FTS5 and vector search from [search-features.md](search-features.md), reading full pages from [database-storage.md](database-storage.md), and listing pages.

The server supports both authenticated user-specific wikis and public wikis. Authentication uses a Bearer token in the `Authorization` header to select the user's database via [authentication.md](authentication.md); without a valid token, it falls back to the public database. This design ensures seamless integration under the API routes described in [architecture.md](architecture.md), leveraging core components for secure, searchable access to wiki data.

## Endpoint and Authentication

The MCP server listens for POST requests to `/api/mcp`. Each request body contains a JSON-RPC 2.0 payload. The handler extracts the Bearer token, validates it to load the appropriate database, and dispatches to method-specific logic in `src/lib/mcp.ts`.

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

This middleware pattern aligns with other API routes, ensuring consistent authentication and database isolation.

## Supported Methods

The server handles these JSON-RPC methods:

- **`initialize`**: Returns protocol version, capabilities, and server info. Signals connection readiness.
- **`notifications/initialized`**: Acknowledges client initialization (no-op response).
- **`tools/list`**: Returns the list of available tools with schemas.
- **`tools/call`**: Invokes a tool by name with arguments, returning results as text blocks.

Unknown methods return a standard JSON-RPC error.

## Available Tools

Four tools provide wiki access. Agents discover them via `tools/list` and call via `tools/call`. Each tool operates on the authenticated database (user or public).

| Tool | Description | Parameters |
|------|-------------|------------|
| `list_wikis` | Lists all wikis with names and descriptions. | None |
| `search_wiki` | Performs hybrid search ([search-features.md](search-features.md)) on a wiki, returning ranked chunks. | `wiki` (string, required), `query` (string, required), `limit` (number, optional, default 10) |
| `read_page` | Retrieves full markdown content of a page, appending recent updates if available. | `wiki` (string, required), `page` (string, required; appends `.md` if missing) |
| `list_pages` | Lists all `.md` pages in a wiki (strips `.md` extension). | `wiki` (string, required) |

Tool schemas match JSON Schema for validation. Results use MCP's `content` array with `type: "text"`.

From `src/lib/mcp.ts`:

```typescript
export const MCP_TOOLS: McpTool[] = [
  {
    name: "list_wikis",
    description: "List all available wikis.",
    inputSchema: { type: "object", properties: {} },
  },
  // ... (search_wiki, read_page, list_pages definitions)
];
```

## Tool Implementation

The `handleToolCall` function in `src/lib/mcp.ts` dispatches based on tool name, using database queries and helpers:

- **`list_wikis`**: Queries `wikis` table for `name` and `description`.
- **`search_wiki`**: Validates wiki, calls `search` from [search-features.md](search-features.md), formats top results with paths, scores, and previews.
- **`read_page`**: Resolves path (adds `.md`), fetches via `getFile` from [database-storage.md](database-storage.md), appends updates from `getPageUpdates`.
- **`list_pages`**: Filters `wiki_files` for `.md` paths via `listFiles`.

Example `search_wiki` result formatting:

```
1. **architecture** (score: 0.95)
   The server maintains a vector index for wiki chunks only...

2. **mcp-integration** (score: 0.87)
   MCP exposes wiki functionalities...
```

Errors return `isError: true` with descriptive text, such as wiki or page not found.

From `src/lib/mcp.ts`:

```typescript
export async function handleToolCall(
  db: Database,
  toolName: string,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  switch (toolName) {
    case "search_wiki": {
      const wikiName = args.wiki as string;
      const query = args.query as string;
      const limit = (args.limit as number) || 10;
      const wiki = getWiki(db, wikiName);
      if (!wiki) return errorResult(`Wiki "${wikiName}" not found.`);
      const results = await search(db, wiki.id, query, { limit });
      // ... format and return textResult
    }
    // ... other cases
  }
}
```

## Request Handling

The `handleMcpRequest` function parses the JSON-RPC body and routes accordingly. It supports batched requests implicitly via standard JSON-RPC dispatching.

From `src/lib/mcp.ts`:

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
    case 'tools/list':
      return { jsonrpc: '2.0', id, result: { tools: MCP_TOOLS } };
    case 'tools/call': {
      const p = params as { name?: string; arguments?: Record<string, unknown> };
      const toolName = p.name as string;
      const args = p.arguments ?? {};
      const result = await handleToolCall(db, toolName, args);
      return { jsonrpc: '2.0', id, result };
    }
    // ... other cases and default error
  }
}
```

## Design Decisions

JSON-RPC 2.0 ensures broad compatibility across MCP ecosystems. Fallback to public database enables unauthenticated access to showcase wikis. Tools focus on read-only operations to prevent unauthorized writes, aligning with wiki consumption patterns. Hybrid search integration provides semantic relevance without full context dumps, optimizing token usage in agent workflows.

This setup positions wikis as a native knowledge base for MCP agents, composable with other tools for codebase analysis and documentation retrieval.