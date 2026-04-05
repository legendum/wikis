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
 * Escape a query string for FTS5 — wrap each word in double quotes
 * to avoid syntax errors from special characters.
 */
function escapeFtsQuery(query: string): string {
  return query
    .replace(/[^\w\s*]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => (word.includes("*") ? word : `"${word}"`))
    .join(" OR ");
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
 * Search wiki — FTS5 first, vector fallback, hybrid merge.
 */
export async function search(
  db: Database,
  wikiId: number,
  query: string,
  opts: { limit?: number } = {}
): Promise<SearchResult[]> {
  const limit = opts.limit ?? SEARCH_DEFAULT_LIMIT;

  const results: SearchResult[] = ftsSearch(db, query, limit).map((row) => ({
    path: row.path,
    chunk: row.content,
    score: row.rank,
  }));

  if (results.length >= limit) {
    const worst = Math.min(...results.map((r) => r.score));
    for (const r of results) r.score = normalizeFtsRank(r.score, worst);
    return results.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  // Vector fallback
  let queryEmbedding: Float32Array;
  try {
    queryEmbedding = await embedOne(query);
  } catch {
    const worst = Math.min(...results.map((r) => r.score), -1);
    for (const r of results) r.score = normalizeFtsRank(r.score, worst);
    return results.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  const ftsKeys = new Set(results.map((r) => `${r.path}:${r.chunk.slice(0, 50)}`));

  for (const v of vectorSearch(db, wikiId, queryEmbedding, limit)) {
    const key = `${v.path}:${v.content.slice(0, 50)}`;
    if (!ftsKeys.has(key)) {
      results.push({ path: v.path, chunk: v.content, score: v.score * SEARCH_VECTOR_WEIGHT });
    }
  }

  const worst = Math.min(...results.filter((r) => r.score < 0).map((r) => r.score), -1);
  for (const r of results) {
    if (r.score < 0) r.score = normalizeFtsRank(r.score, worst) * SEARCH_FTS_WEIGHT;
  }

  return results.sort((a, b) => b.score - a.score).slice(0, limit);
}

/**
 * FTS-only search — no vector fallback. Fastest path.
 */
export function searchFts(
  db: Database,
  query: string,
  opts: { limit?: number } = {}
): SearchResult[] {
  const limit = opts.limit ?? SEARCH_DEFAULT_LIMIT;
  return ftsSearch(db, query, limit).map((row) => ({
    path: row.path,
    chunk: row.content,
    score: row.rank,
  })).sort((a, b) => a.score - b.score).slice(0, limit);
}
