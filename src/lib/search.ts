import { Database } from "bun:sqlite";
import {
  SEARCH_FTS_WEIGHT,
  SEARCH_VECTOR_WEIGHT,
  SEARCH_DEFAULT_LIMIT,
} from "./constants";
import { embedOne, cosineSimilarity, deserializeEmbedding } from "./rag";

export interface SearchResult {
  path: string;
  chunk: string;
  score: number;
}

interface FtsRow {
  path: string;
  content: string;
  rank: number;
}

interface ChunkRow {
  id: number;
  path: string;
  content: string;
  embedding: Buffer | null;
}

/**
 * Escape a query string for FTS5 — strip special chars, wrap each
 * word in double quotes to prevent syntax errors.
 */
function escapeFtsQuery(query: string): string {
  // Strip everything except word chars, whitespace, and * (for prefix)
  const cleaned = query.replace(/[^\w\s*]/g, " ");
  const words = cleaned
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => {
      // Strip leading/trailing asterisks, then re-add one trailing * if present
      const base = word.replace(/\*/g, "");
      if (!base) return null; // was only special chars
      return word.includes("*") ? `"${base}"*` : `"${base}"`;
    })
    .filter(Boolean);

  if (words.length === 0) return "";
  return words.join(" OR ");
}

function ftsSearch(db: Database, query: string, limit: number): FtsRow[] {
  const escaped = escapeFtsQuery(query);
  if (!escaped) return [];

  try {
    return db
      .prepare(
        `SELECT path, content, rank FROM wiki_chunks_fts WHERE wiki_chunks_fts MATCH ? ORDER BY rank LIMIT ?`
      )
      .all(escaped, limit) as FtsRow[];
  } catch {
    return [];
  }
}

/**
 * Vector search — scans wiki chunk embeddings, ranks by cosine similarity.
 */
function vectorSearch(
  db: Database,
  wikiId: number,
  queryEmbedding: Float32Array,
  limit: number
): { path: string; content: string; score: number }[] {
  const rows = db
    .prepare(
      `SELECT id, path, content, embedding FROM wiki_chunks WHERE wiki_id = ? AND embedding IS NOT NULL`
    )
    .all(wikiId) as ChunkRow[];

  return rows
    .map((row) => ({
      path: row.path,
      content: row.content,
      score: cosineSimilarity(queryEmbedding, deserializeEmbedding(row.embedding!)),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

function normalizeFtsRank(rank: number, maxRank: number): number {
  if (maxRank === 0) return 0;
  return Math.max(0, 1 - rank / maxRank);
}

/**
 * Search wiki — FTS5 for candidates, re-ranked by vector similarity.
 * FTS finds keyword matches fast, RAG orders them by semantic relevance.
 */
export async function search(
  db: Database,
  wikiId: number,
  query: string,
  opts: { limit?: number } = {}
): Promise<SearchResult[]> {
  const limit = opts.limit ?? SEARCH_DEFAULT_LIMIT;
  const FTS_CANDIDATES = 50;

  // Step 1: FTS candidates
  const ftsResults = ftsSearch(db, query, FTS_CANDIDATES);
  if (ftsResults.length === 0) return [];

  // Step 2: embed the query and re-rank by cosine similarity
  let queryEmbedding: Float32Array | null = null;
  try {
    queryEmbedding = await embedOne(query);
  } catch {
    // Ollama unavailable — fall back to FTS rank order
  }

  if (!queryEmbedding) {
    // FTS-only fallback
    const worst = Math.min(...ftsResults.map((r) => r.rank));
    return ftsResults.map((row) => ({
      path: row.path,
      chunk: row.content,
      score: normalizeFtsRank(row.rank, worst),
    })).sort((a, b) => b.score - a.score).slice(0, limit);
  }

  // Look up embeddings for the FTS candidate chunks
  const worstRank = Math.min(...ftsResults.map((r) => r.rank));
  const results: SearchResult[] = [];
  for (const row of ftsResults) {
    const chunkRow = db.prepare(
      "SELECT embedding FROM wiki_chunks WHERE wiki_id = ? AND path = ? AND content = ? AND embedding IS NOT NULL LIMIT 1"
    ).get(wikiId, row.path, row.content) as { embedding: Buffer } | null;

    let score: number;
    if (chunkRow?.embedding) {
      score = cosineSimilarity(queryEmbedding, deserializeEmbedding(chunkRow.embedding));
    } else {
      score = normalizeFtsRank(row.rank, worstRank) * 0.5;
    }

    results.push({ path: row.path, chunk: row.content, score });
  }

  return results.sort((a, b) => b.score - a.score).slice(0, limit);
}

