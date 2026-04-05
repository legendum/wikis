import { SEARCH_CHUNK_OVERLAP, SEARCH_CHUNK_SIZE } from './constants';

export interface Chunk {
  path: string;
  chunkIndex: number;
  content: string;
}

/**
 * Split text into chunks respecting line boundaries.
 * Uses character count (not tokens) for simplicity — good enough for FTS and embeddings.
 */
export function chunkText(
  path: string,
  text: string,
  chunkSize = SEARCH_CHUNK_SIZE,
  overlap = SEARCH_CHUNK_OVERLAP
): Chunk[] {
  const lines = text.split('\n');
  const chunks: Chunk[] = [];
  let current = '';
  let chunkIndex = 0;

  for (const line of lines) {
    if (current.length + line.length + 1 > chunkSize && current.length > 0) {
      chunks.push({ path, chunkIndex, content: current.trim() });
      chunkIndex++;

      // Keep overlap: take the last `overlap` characters of current chunk
      if (overlap > 0 && current.length > overlap) {
        current = current.slice(-overlap);
        // Re-align to line boundary
        const newlinePos = current.indexOf('\n');
        if (newlinePos !== -1) {
          current = current.slice(newlinePos + 1);
        }
      } else {
        current = '';
      }
    }
    current += (current ? '\n' : '') + line;
  }

  // Final chunk
  if (current.trim()) {
    chunks.push({ path, chunkIndex, content: current.trim() });
  }

  return chunks;
}

/**
 * Chunk a batch of files. Returns all chunks with file paths.
 */
export function chunkFiles(
  files: { path: string; content: string }[],
  chunkSize?: number,
  overlap?: number
): Chunk[] {
  return files.flatMap((f) => chunkText(f.path, f.content, chunkSize, overlap));
}
