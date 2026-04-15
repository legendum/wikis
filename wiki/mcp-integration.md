# MCP Integration

## Overview

MCP (Model Context Protocol) provides a standardized JSON-RPC 2.0 interface that exposes wiki functionalities as tools for AI agents. The wikis project implements an MCP server at the `/api/mcp` HTTP endpoint via POST requests. This enables MCP-compliant agents, such as those from Anthropic, to discover available tools and invoke them without custom HTTP client code. Tools support listing wikis, searching content with hybrid FTS5 and vector search from [search-features.md](search-features.md), reading full pages from [database-storage.md](database-storage.md), and listing pages.

The server supports both authenticated user-specific wikis and public wikis. In hosted mode, authentication uses a Bearer token in the `Authorization` header to select the user's database via [authentication.md](authentication.md); without a valid token, it falls back to the public database. In self-hosted mode, requests use the local user database directly, with fallback to public if needed. This design integrates seamlessly under the API routes in [architecture.md](architecture.md), leveraging core components for secure, searchable access to wiki data. See [self-hosting.md](self-hosting.md) for self-hosting details.

## Endpoint and Authentication

The MCP server processes POST requests to `/api/mcp`. Each request body contains a JSON-RPC 2.0 payload. The handler determines the database based on mode and authentication, then dispatches to method-specific logic in `src/lib/mcp.ts`.

From `src/routes/api.ts`:

```typescript
.post("/mcp", async ({ body, headers }) => {
  // MCP supports both authenticated (user wikis) and public wikis.
  // In self-hosted mode the local user db is the only "authenticated" db.
  let db: Database;
  if (isSelfHosted()) {
    ensureLocalUser();
    db = getUserDb(LOCAL_USER_ID);
  } else {
    const token = extractBearerToken(headers.authorization);
    if (token) {
      const user = validateAccountKey(token);
      if (user) {
        db = getUserDb(user.id);
      }
    }
  }
  // Fall back to public DB
  if (!db) db = getPublicDb();

  const result = await handleMcpRequest(db, body as Record<string, unknown>);
  return result;
});
```

This middleware ensures consistent authentication and database isolation across API routes, prioritizing user databases and falling back to public content.

## Supported Methods

The server implements these JSON-RPC 2.0 methods:

- **`initialize`**: Returns protocol version, capabilities, and server information to signal readiness.
- **`notifications/initialized`**: Acknowledges client initialization with an empty result (no-op for notifications).
- **`tools/list`**: Lists available tools with JSON Schema definitions for input validation.
- **`tools/call`**: Executes a named tool with provided arguments, returning results as text content blocks.

Unknown methods or invalid requests yield standard JSON-RPC errors with code -32601.

## Available Tools

Agents discover tools via `tools/list` and invoke them via `tools/call`. Each tool operates on the resolved database (user, local user in self-hosted mode, or public).

| Tool | Description | Parameters |
|------|-------------|------------|
| `list_wikis` | Lists all wikis with names and descriptions. | None |
| `search_wiki` | Performs hybrid search ([search-features.md](search-features.md)) on a wiki, returning ranked chunks with previews. | `wiki` (string, required), `query` (string, required), `limit` (number, optional, default 10) |
| `read_page` | Retrieves full markdown content of a page, appending recent updates if available. | `wiki` (string, required), `page` (string, required; `.md` appended if missing) |
| `list_pages` | Lists all `.md` pages in a wiki (`.md` extension stripped). | `wiki` (string, required) |

Tool input schemas conform to JSON Schema. Results use MCP `content` arrays with `type: "text"`. Errors set `isError: true` with descriptive text.

From `src/lib/mcp.ts`:

```typescript
export const MCP_TOOLS: McpTool[] = [
  {
    name: "list_wikis",
    description: "List all available wikis.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "search_wiki",
    description: "Search wiki pages by keyword or semantic query. Returns matching chunks ranked by relevance.",
    inputSchema: {
      type: "object",
      properties: {
        wiki: { type: "string", description: "Wiki name (e.g. 'depends')" },
        query: { type: "string", description: "Search query" },
        limit: { type: "number", description: "Max results (default 10)" },
      },
      required: ["wiki", "query"],
    },
  },
  // ... read_page, list_pages definitions
];
```

## Tool Implementation

The `handleToolCall` function in `src/lib/mcp.ts` routes to tool-specific handlers using database queries and shared utilities:

- **`list_wikis`**: Queries the `wikis` table, formats as bullet list with descriptions.
- **`search_wiki`**: Validates wiki existence, invokes `search` from [search-features.md](search-features.md), formats top results with page paths, scores, and 200-character previews.
- **`read_page`**: Resolves path (appends `.md`), fetches via `getFile` from [database-storage.md](database-storage.md), appends updates from `getPageUpdates` under "## Recent Changes".
- **`list_pages`**: Uses `listFiles` from [database-storage.md](database-storage.md), filters `.md` files, strips extensions, joins as newline-separated list.

Example `search_wiki` output:

```
1. **architecture** (score: 0.95)
   The server maintains a vector index for wiki chunks only...

2. **mcp-integration** (score: 0.87)
   MCP exposes wiki functionalities...
```

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
      if (results.length === 0) return textResult("No results found.");
      const text = results
        .map((r, i) => {
          const page = r.path.replace(/\.md$/, "");
          return `${i + 1}. **${page}** (score: ${r.score.toFixed(2)})\n   ${r.chunk.slice(0, 200)}`;
        })
        .join("\n\n");
      return textResult(text);
    }
    // ... other cases
    default:
      return errorResult(`Unknown tool: ${toolName}`);
  }
}
```

## Request Handling

The `handleMcpRequest` function parses the JSON-RPC payload and dispatches methods. It supports single requests and implicit batching via standard JSON-RPC rules.

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
    case 'notifications/initialized':
      return { jsonrpc: '2.0', id, result: {} };
    case 'tools/list':
      return { jsonrpc: '2.0', id, result: { tools: MCP_TOOLS } };
    case 'tools/call': {
      const p = params as { name?: string; arguments?: Record<string, unknown> };
      const toolName = p.name as string;
      const args = p.arguments ?? {};
      const result = await handleToolCall(db, toolName, args);
      return { jsonrpc: '2.0', id, result };
    }
    default:
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      };
  }
}
```

## Design Decisions

JSON-RPC 2.0 over HTTP ensures compatibility with MCP ecosystems. Self-hosted mode prioritizes the local user database for seamless operation without authentication. Public database fallback enables unauthenticated access to showcase wikis. Tools emphasize read-only operations to align with wiki consumption patterns and prevent unauthorized modifications. Hybrid search integration delivers semantic relevance efficiently, optimizing token usage in agent workflows. Results format as concise, parseable text blocks suitable for LLM consumption.

This positions wikis as a composable knowledge base for MCP agents, integrable with tools for codebase analysis, documentation retrieval, and more.