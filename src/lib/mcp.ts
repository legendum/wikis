/**
 * MCP (Model Context Protocol) server for wikis.fyi.
 *
 * Exposes wiki search, read, and list as tools for AI agents.
 * Mounted at /mcp as an HTTP transport endpoint.
 */
import type { Database } from "bun:sqlite";
import { searchAllWikis } from "./search";
import { wikiPageUrl } from "./public-wiki-urls";
import { getFile, getPageUpdates, listFiles } from "./storage";

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

export const MCP_TOOLS: McpTool[] = [
  {
    name: "list",
    description: "List all available wikis.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "search",
    description:
      "Search all of the user's wikis (FTS + optional semantic re-ranking). Returns snippets with page links.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Free-form search text" },
      },
      required: ["query"],
    },
  },
  {
    name: "read_page",
    description: "Read the full markdown content of a wiki page.",
    inputSchema: {
      type: "object",
      properties: {
        wiki: { type: "string", description: "Wiki name (e.g. 'depends')" },
        page: {
          type: "string",
          description: "Page name without .md extension (e.g. 'architecture')",
        },
      },
      required: ["wiki", "page"],
    },
  },
  {
    name: "list_pages",
    description: "List all pages in a wiki.",
    inputSchema: {
      type: "object",
      properties: {
        wiki: { type: "string", description: "Wiki name (e.g. 'depends')" },
      },
      required: ["wiki"],
    },
  },
];

function getWiki(db: Database, wikiName: string): { id: number } | null {
  return db.prepare("SELECT id FROM wikis WHERE name = ?").get(wikiName) as {
    id: number;
  } | null;
}

function textResult(text: string): McpToolResult {
  return { content: [{ type: "text", text }] };
}

function errorResult(text: string): McpToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

export async function handleToolCall(
  db: Database,
  toolName: string,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  switch (toolName) {
    case "list": {
      const wikis = db
        .prepare("SELECT name, description FROM wikis ORDER BY name")
        .all() as { name: string; description: string }[];
      if (wikis.length === 0) return textResult("No wikis found.");
      const text = wikis
        .map((w) =>
          w.description ? `- ${w.name}: ${w.description}` : `- ${w.name}`,
        )
        .join("\n");
      return textResult(text);
    }

    case "search": {
      const query = args.query as string;

      const results = await searchAllWikis(db, query, {});
      if (results.length === 0) return textResult("No results found.");

      const text = results
        .map((r, i) => {
          const page = r.path.replace(/\.md$/, "");
          const url = wikiPageUrl(r.wiki, r.path);
          return `${i + 1}. **${r.wiki} / ${page}** (score: ${r.score.toFixed(2)})\n   ${url}\n   ${r.chunk.slice(0, 200)}`;
        })
        .join("\n\n");

      return textResult(text);
    }

    case "read_page": {
      const wikiName = args.wiki as string;
      const page = args.page as string;

      const wiki = getWiki(db, wikiName);
      if (!wiki) return errorResult(`Wiki "${wikiName}" not found.`);

      const path = page.endsWith(".md") ? page : `${page}.md`;
      const file = getFile(db, wiki.id, path);
      if (!file?.content)
        return errorResult(`Page "${page}" not found in wiki "${wikiName}".`);

      const updates = getPageUpdates(db, wiki.id, path);
      if (updates.length > 0) {
        const log = updates
          .map((u) => `- ${u.created_at}: ${u.summary}`)
          .join("\n");
        return textResult(
          `${file.content}\n\n---\n\n## Recent Changes\n\n${log}`,
        );
      }

      return textResult(file.content);
    }

    case "list_pages": {
      const wikiName = args.wiki as string;

      const wiki = getWiki(db, wikiName);
      if (!wiki) return errorResult(`Wiki "${wikiName}" not found.`);

      const files = listFiles(db, wiki.id);
      const pages = files
        .filter((f) => f.path.endsWith(".md"))
        .map((f) => f.path.replace(/\.md$/, ""));

      if (pages.length === 0) return textResult("No pages found.");
      return textResult(pages.join("\n"));
    }

    default:
      return errorResult(`Unknown tool: ${toolName}`);
  }
}

/**
 * Handle an MCP JSON-RPC request.
 * Supports: initialize, tools/list, tools/call
 */
export async function handleMcpRequest(
  db: Database,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { method, id, params } = body as {
    method: string;
    id: unknown;
    params?: Record<string, unknown>;
  };

  switch (method) {
    case "initialize":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "wikis.fyi", version: "1.0.0" },
        },
      };

    case "notifications/initialized":
      // Client ack — no response needed for notifications
      return { jsonrpc: "2.0", id, result: {} };

    case "tools/list":
      return {
        jsonrpc: "2.0",
        id,
        result: { tools: MCP_TOOLS },
      };

    case "tools/call": {
      const p = params as {
        name?: string;
        arguments?: Record<string, unknown>;
      };
      const toolName = p.name as string;
      const args = p.arguments ?? {};
      const result = await handleToolCall(db, toolName, args);
      return { jsonrpc: "2.0", id, result };
    }

    default:
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      };
  }
}
