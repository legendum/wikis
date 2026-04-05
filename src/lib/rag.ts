import { OLLAMA_EMBED_MODEL, OLLAMA_URL } from "./constants";

/**
 * Get embeddings from Ollama for a list of texts.
 * Returns float32 arrays (one per input text).
 */
export async function embed(texts: string[]): Promise<Float32Array[]> {
  const results: Float32Array[] = [];

  for (const text of texts) {
    const res = await fetch(`${OLLAMA_URL}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: OLLAMA_EMBED_MODEL, input: text }),
    });

    if (!res.ok) {
      throw new Error(
        `Ollama embed failed (${res.status}): ${await res.text()}`,
      );
    }

    const data = (await res.json()) as { embeddings: number[][] };
    results.push(new Float32Array(data.embeddings[0]));
  }

  return results;
}

/**
 * Embed a single text string.
 */
export async function embedOne(text: string): Promise<Float32Array> {
  const [result] = await embed([text]);
  return result;
}

/**
 * Cosine similarity between two float32 vectors.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(`Vector length mismatch: ${a.length} vs ${b.length}`);
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Serialize a Float32Array to a Buffer for SQLite BLOB storage.
 */
export function serializeEmbedding(embedding: Float32Array): Buffer {
  return Buffer.from(embedding.buffer);
}

/**
 * Deserialize a Buffer from SQLite BLOB to Float32Array.
 */
export function deserializeEmbedding(blob: Buffer): Float32Array {
  return new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
}
