import type { Database } from "bun:sqlite";
import { type Chunk, chunkText } from "./chunking";
import { log } from "./log";
import { embed, serializeEmbedding } from "./rag";

type ChunkTable = "wiki_chunks";

/**
 * Index a file into a chunk table (source or wiki).
 * Replaces all existing chunks for that file path.
 * Embeddings are computed async and stored in a second pass.
 */
export async function indexFile(
  db: Database,
  wikiId: number,
  table: ChunkTable,
  path: string,
  content: string,
  opts: { embeddings?: boolean } = {},
): Promise<number> {
  const chunks = chunkText(path, content);
  if (chunks.length === 0) return 0;

  // Delete existing chunks for this file
  db.prepare(`DELETE FROM ${table} WHERE wiki_id = ? AND path = ?`).run(
    wikiId,
    path,
  );

  // Insert new chunks
  const insert = db.prepare(
    `INSERT INTO ${table} (wiki_id, path, chunk_index, content) VALUES (?, ?, ?, ?)`,
  );

  const insertMany = db.transaction((chunks: Chunk[]) => {
    for (const chunk of chunks) {
      insert.run(wikiId, chunk.path, chunk.chunkIndex, chunk.content);
    }
  });

  insertMany(chunks);

  // Optionally compute and store embeddings
  if (opts.embeddings !== false) {
    try {
      await storeEmbeddings(db, table, wikiId, path, chunks);
    } catch (e) {
      // Ollama not available — FTS still works without embeddings
      log.debug("Embedding indexing skipped", {
        path,
        error: (e as Error).message,
      });
    }
  }

  return chunks.length;
}

/**
 * Compute and store embeddings for chunks.
 */
async function storeEmbeddings(
  db: Database,
  table: ChunkTable,
  wikiId: number,
  path: string,
  chunks: Chunk[],
): Promise<void> {
  const texts = chunks.map((c) => c.content);
  const embeddings = await embed(texts);

  const update = db.prepare(
    `UPDATE ${table} SET embedding = ? WHERE wiki_id = ? AND path = ? AND chunk_index = ?`,
  );

  const updateMany = db.transaction(() => {
    for (let i = 0; i < chunks.length; i++) {
      update.run(
        serializeEmbedding(embeddings[i]),
        wikiId,
        path,
        chunks[i].chunkIndex,
      );
    }
  });

  updateMany();
}

/**
 * Index multiple files at once.
 */
export async function indexFiles(
  db: Database,
  wikiId: number,
  table: ChunkTable,
  files: { path: string; content: string }[],
  opts: { embeddings?: boolean } = {},
): Promise<number> {
  let total = 0;
  for (const file of files) {
    total += await indexFile(db, wikiId, table, file.path, file.content, opts);
  }
  return total;
}

/**
 * Remove all chunks for a file.
 */
export function removeFile(
  db: Database,
  wikiId: number,
  table: ChunkTable,
  path: string,
): void {
  db.prepare(`DELETE FROM ${table} WHERE wiki_id = ? AND path = ?`).run(
    wikiId,
    path,
  );
}
