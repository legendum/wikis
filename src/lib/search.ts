import type { Database } from "bun:sqlite";
import { SEARCH_DEFAULT_LIMIT } from "./constants";
import { log } from "./log";
import { cosineSimilarity, deserializeEmbedding, embedOne } from "./rag";

export interface SearchResult {
  path: string;
  chunk: string;
  score: number;
}

/** One hit when searching across every wiki in the user's database. */
export interface SearchHit {
  wiki: string;
  path: string;
  chunk: string;
  score: number;
}

interface FtsRow {
  path: string;
  content: string;
  rank: number;
}

interface FtsRowAll {
  wiki: string;
  wiki_id: number;
  path: string;
  content: string;
  rank: number;
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

function ftsSearch(
  db: Database,
  wikiId: number,
  query: string,
  limit: number,
): FtsRow[] {
  const escaped = escapeFtsQuery(query);
  if (!escaped) return [];

  try {
    return db
      .prepare(
        `SELECT f.path, f.content, f.rank
         FROM wiki_chunks_fts f
         JOIN wiki_chunks c ON c.id = f.rowid
         WHERE wiki_chunks_fts MATCH ? AND c.wiki_id = ?
         ORDER BY f.rank LIMIT ?`,
      )
      .all(escaped, wikiId, limit) as FtsRow[];
  } catch (e) {
    log.warn("FTS query failed", { error: (e as Error).message, query });
    return [];
  }
}

function ftsSearchAll(
  db: Database,
  query: string,
  limit: number,
): FtsRowAll[] {
  const escaped = escapeFtsQuery(query);
  if (!escaped) return [];

  try {
    return db
      .prepare(
        `SELECT w.name AS wiki, c.wiki_id AS wiki_id, f.path, f.content, f.rank
         FROM wiki_chunks_fts f
         JOIN wiki_chunks c ON c.id = f.rowid
         JOIN wikis w ON w.id = c.wiki_id
         WHERE wiki_chunks_fts MATCH ?
         ORDER BY f.rank
         LIMIT ?`,
      )
      .all(escaped, limit) as FtsRowAll[];
  } catch (e) {
    log.warn("FTS query failed (all wikis)", { error: (e as Error).message, query });
    return [];
  }
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
  opts: { limit?: number } = {},
): Promise<SearchResult[]> {
  const limit = opts.limit ?? SEARCH_DEFAULT_LIMIT;
  const FTS_CANDIDATES = 50;

  // Step 1: FTS candidates
  const ftsResults = ftsSearch(db, wikiId, query, FTS_CANDIDATES);
  if (ftsResults.length === 0) return [];

  // Step 2: embed the query and re-rank by cosine similarity
  let queryEmbedding: Float32Array | null = null;
  try {
    queryEmbedding = await embedOne(query);
  } catch (e) {
    // Ollama unavailable — fall back to FTS rank order
    log.debug("Embedding failed, FTS-only search", {
      error: (e as Error).message,
    });
  }

  if (!queryEmbedding) {
    // FTS-only fallback
    const worst = Math.min(...ftsResults.map((r) => r.rank));
    return ftsResults
      .map((row) => ({
        path: row.path,
        chunk: row.content,
        score: normalizeFtsRank(row.rank, worst),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  // Look up embeddings for the FTS candidate chunks
  const worstRank = Math.min(...ftsResults.map((r) => r.rank));
  const results: SearchResult[] = [];
  for (const row of ftsResults) {
    const chunkRow = db
      .prepare(
        "SELECT embedding FROM wiki_chunks WHERE wiki_id = ? AND path = ? AND content = ? AND embedding IS NOT NULL LIMIT 1",
      )
      .get(wikiId, row.path, row.content) as { embedding: Buffer } | null;

    let score: number;
    if (chunkRow?.embedding) {
      score = cosineSimilarity(
        queryEmbedding,
        deserializeEmbedding(chunkRow.embedding),
      );
    } else {
      score = normalizeFtsRank(row.rank, worstRank) * 0.5;
    }

    results.push({ path: row.path, chunk: row.content, score });
  }

  return results.sort((a, b) => b.score - a.score).slice(0, limit);
}

const FTS_CANDIDATES_ALL = 80;

/**
 * Search every wiki in this database — same FTS + embedding pipeline as {@link search},
 * but candidates come from all `wikis` rows (one user DB).
 */
export async function searchAllWikis(
  db: Database,
  query: string,
  opts: { limit?: number } = {},
): Promise<SearchHit[]> {
  const limit = opts.limit ?? SEARCH_DEFAULT_LIMIT;

  const ftsResults = ftsSearchAll(db, query, FTS_CANDIDATES_ALL);
  if (ftsResults.length === 0) return [];

  let queryEmbedding: Float32Array | null = null;
  try {
    queryEmbedding = await embedOne(query);
  } catch (e) {
    log.debug("Embedding failed, FTS-only search (all wikis)", {
      error: (e as Error).message,
    });
  }

  if (!queryEmbedding) {
    const worst = Math.min(...ftsResults.map((r) => r.rank));
    return ftsResults
      .map((row) => ({
        wiki: row.wiki,
        path: row.path,
        chunk: row.content,
        score: normalizeFtsRank(row.rank, worst),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  const worstRank = Math.min(...ftsResults.map((r) => r.rank));
  const results: SearchHit[] = [];
  for (const row of ftsResults) {
    const chunkRow = db
      .prepare(
        "SELECT embedding FROM wiki_chunks WHERE wiki_id = ? AND path = ? AND content = ? AND embedding IS NOT NULL LIMIT 1",
      )
      .get(row.wiki_id, row.path, row.content) as { embedding: Buffer } | null;

    let score: number;
    if (chunkRow?.embedding) {
      score = cosineSimilarity(
        queryEmbedding,
        deserializeEmbedding(chunkRow.embedding),
      );
    } else {
      score = normalizeFtsRank(row.rank, worstRank) * 0.5;
    }

    results.push({
      wiki: row.wiki,
      path: row.path,
      chunk: row.content,
      score,
    });
  }

  return results.sort((a, b) => b.score - a.score).slice(0, limit);
}
