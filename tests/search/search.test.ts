import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import { createTestDataDir } from "../helpers/db";

/**
 * End-to-end-ish test for the FTS-only path of search().
 *
 * The real search() function in src/lib/search.ts first runs an FTS5 query
 * for candidates, then re-ranks via embeddings. When Ollama is unavailable
 * (as it is in CI), it falls back to FTS rank order. This test exercises:
 *  - escapeFtsQuery handling of arbitrary user input
 *  - the SQL FTS query joined to wiki_chunks scoped by wiki_id
 *  - the FTS-only fallback path returning normalized scores
 *
 * The functions are inlined to keep the test free of any dependency on
 * rag.ts/Ollama.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS wiki_chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wiki_id INTEGER NOT NULL,
  path TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  embedding BLOB
);
CREATE VIRTUAL TABLE wiki_chunks_fts USING fts5(
  path,
  content,
  content=wiki_chunks,
  content_rowid=id,
  tokenize='porter unicode61'
);
CREATE TRIGGER wiki_chunks_ai AFTER INSERT ON wiki_chunks BEGIN
  INSERT INTO wiki_chunks_fts(rowid, path, content) VALUES (new.id, new.path, new.content);
END;
`;

function escapeFtsQuery(query: string): string {
  const cleaned = query.replace(/[^\w\s*]/g, " ");
  const words = cleaned
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => {
      const base = word.replace(/\*/g, "");
      if (!base) return null;
      return word.includes("*") ? `"${base}"*` : `"${base}"`;
    })
    .filter(Boolean);
  if (words.length === 0) return "";
  return words.join(" OR ");
}

interface SearchResult {
  path: string;
  chunk: string;
  score: number;
}

function normalizeFtsRank(rank: number, maxRank: number): number {
  if (maxRank === 0) return 0;
  return Math.max(0, 1 - rank / maxRank);
}

function searchFtsOnly(
  db: Database,
  wikiId: number,
  query: string,
  limit = 20,
): SearchResult[] {
  const escaped = escapeFtsQuery(query);
  if (!escaped) return [];

  let rows: { path: string; content: string; rank: number }[];
  try {
    rows = db
      .prepare(
        `SELECT f.path, f.content, f.rank
         FROM wiki_chunks_fts f
         JOIN wiki_chunks c ON c.id = f.rowid
         WHERE wiki_chunks_fts MATCH ? AND c.wiki_id = ?
         ORDER BY f.rank LIMIT ?`,
      )
      .all(escaped, wikiId, 50) as typeof rows;
  } catch {
    return [];
  }

  if (rows.length === 0) return [];

  const worst = Math.min(...rows.map((r) => r.rank));
  return rows
    .map((row) => ({
      path: row.path,
      chunk: row.content,
      score: normalizeFtsRank(row.rank, worst),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

describe("escapeFtsQuery", () => {
  it("quotes individual words", () => {
    expect(escapeFtsQuery("hello world")).toBe('"hello" OR "world"');
  });

  it("strips operator characters", () => {
    expect(escapeFtsQuery("foo AND bar OR baz")).toBe(
      '"foo" OR "AND" OR "bar" OR "OR" OR "baz"',
    );
  });

  it("handles SQL-injection attempts", () => {
    expect(escapeFtsQuery("'; DROP TABLE x;--")).toBe(
      '"DROP" OR "TABLE" OR "x"',
    );
  });

  it("returns empty string for all-special input", () => {
    expect(escapeFtsQuery("!@#$%^&()")).toBe("");
  });

  it("preserves prefix asterisks", () => {
    expect(escapeFtsQuery("foo*")).toBe('"foo"*');
  });

  it("handles empty query", () => {
    expect(escapeFtsQuery("")).toBe("");
    expect(escapeFtsQuery("   ")).toBe("");
  });
});

describe("normalizeFtsRank", () => {
  it("returns 0 when maxRank is 0", () => {
    expect(normalizeFtsRank(-3, 0)).toBe(0);
  });

  it("clamps negative results to 0", () => {
    // 1 - (-10 / -5) = -1, clamped to 0
    expect(normalizeFtsRank(-10, -5)).toBe(0);
  });

  it("produces a value in [0, 1] for typical inputs", () => {
    const v = normalizeFtsRank(-2, -10);
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThanOrEqual(1);
  });
});

describe("search (FTS-only fallback)", () => {
  let tmp: { dir: string; cleanup: () => void };
  let db: Database;

  beforeEach(() => {
    tmp = createTestDataDir();
    db = new Database(resolve(tmp.dir, "search.db"), { create: true });
    db.exec(SCHEMA);
  });

  afterEach(() => {
    db.close();
    tmp.cleanup();
  });

  function seed(wikiId: number, path: string, content: string) {
    db.prepare(
      "INSERT INTO wiki_chunks (wiki_id, path, chunk_index, content) VALUES (?, ?, 0, ?)",
    ).run(wikiId, path, content);
  }

  it("returns empty for empty query", () => {
    seed(1, "page.md", "hello world");
    expect(searchFtsOnly(db, 1, "")).toEqual([]);
  });

  it("finds chunks containing the query terms", () => {
    seed(1, "intro.md", "the architecture is layered");
    seed(1, "api.md", "REST endpoints for the API");
    const results = searchFtsOnly(db, 1, "architecture");
    expect(results).toHaveLength(1);
    expect(results[0].path).toBe("intro.md");
  });

  it("scopes results to a single wiki", () => {
    seed(1, "a.md", "shared keyword");
    seed(2, "b.md", "shared keyword");
    const results = searchFtsOnly(db, 1, "shared");
    expect(results).toHaveLength(1);
    expect(results[0].path).toBe("a.md");
  });

  it("returns all matching chunks", () => {
    seed(1, "a.md", "keyword once");
    seed(1, "b.md", "keyword keyword");
    const results = searchFtsOnly(db, 1, "keyword");
    expect(results).toHaveLength(2);
    const paths = results.map((r) => r.path).sort();
    expect(paths).toEqual(["a.md", "b.md"]);
  });

  it("survives malicious-looking input without throwing", () => {
    seed(1, "page.md", "innocent content");
    expect(() =>
      searchFtsOnly(db, 1, "'; DROP TABLE wiki_chunks;--"),
    ).not.toThrow();
  });

  it("respects the limit parameter", () => {
    for (let i = 0; i < 10; i++) seed(1, `page${i}.md`, "match");
    const results = searchFtsOnly(db, 1, "match", 3);
    expect(results).toHaveLength(3);
  });

  it("returns empty when no chunks match", () => {
    seed(1, "page.md", "hello");
    expect(searchFtsOnly(db, 1, "goodbye")).toEqual([]);
  });
});
