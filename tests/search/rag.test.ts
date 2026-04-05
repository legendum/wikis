import { describe, it, expect } from "bun:test";
import {
  cosineSimilarity,
  serializeEmbedding,
  deserializeEmbedding,
} from "../../src/lib/rag";

describe("cosineSimilarity", () => {
  it("returns 1 for identical vectors", () => {
    const a = new Float32Array([1, 2, 3]);
    const b = new Float32Array([1, 2, 3]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(1.0, 5);
  });

  it("returns 0 for orthogonal vectors", () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([0, 1, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(0.0, 5);
  });

  it("returns -1 for opposite vectors", () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([-1, 0, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1.0, 5);
  });

  it("handles high-dimensional vectors", () => {
    const dim = 384; // all-minilm dimension
    const a = new Float32Array(dim);
    const b = new Float32Array(dim);
    for (let i = 0; i < dim; i++) {
      a[i] = Math.random() - 0.5;
      b[i] = a[i]; // same vector
    }
    expect(cosineSimilarity(a, b)).toBeCloseTo(1.0, 4);
  });

  it("returns 0 for zero vectors", () => {
    const a = new Float32Array([0, 0, 0]);
    const b = new Float32Array([1, 2, 3]);
    expect(cosineSimilarity(a, b)).toBe(0);
  });

  it("throws on mismatched dimensions", () => {
    const a = new Float32Array([1, 2]);
    const b = new Float32Array([1, 2, 3]);
    expect(() => cosineSimilarity(a, b)).toThrow("Vector length mismatch");
  });
});

describe("embedding serialization", () => {
  it("round-trips a Float32Array through Buffer", () => {
    const original = new Float32Array([0.1, 0.2, -0.3, 0.999, -0.001]);
    const blob = serializeEmbedding(original);
    const restored = deserializeEmbedding(blob);

    expect(restored.length).toBe(original.length);
    for (let i = 0; i < original.length; i++) {
      expect(restored[i]).toBeCloseTo(original[i], 5);
    }
  });

  it("handles 384-dimensional vectors (all-minilm)", () => {
    const dim = 384;
    const original = new Float32Array(dim);
    for (let i = 0; i < dim; i++) original[i] = Math.random() * 2 - 1;

    const blob = serializeEmbedding(original);
    expect(blob.length).toBe(dim * 4); // 4 bytes per float32

    const restored = deserializeEmbedding(blob);
    expect(restored.length).toBe(dim);

    for (let i = 0; i < dim; i++) {
      expect(restored[i]).toBeCloseTo(original[i], 5);
    }
  });

  it("handles empty vector", () => {
    const original = new Float32Array(0);
    const blob = serializeEmbedding(original);
    const restored = deserializeEmbedding(blob);
    expect(restored.length).toBe(0);
  });
});
