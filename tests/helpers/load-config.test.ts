import { describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import yaml from "js-yaml";
import { createTestDataDir } from "./db";

/**
 * Tests for loadConfig from src/lib/constants.ts. The function is reproduced
 * here because constants.ts has import-time side effects that make it
 * impractical to import directly into a test.
 */

function loadConfig(path: string): Record<string, unknown> {
  const fs = require("node:fs");
  if (!fs.existsSync(path)) return {};
  const parsed = yaml.load(fs.readFileSync(path, "utf8"));
  if (parsed === null || parsed === undefined) return {};
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `Invalid config in ${path}: expected a mapping at the top level`,
    );
  }
  return parsed as Record<string, unknown>;
}

describe("loadConfig", () => {
  it("returns {} when the file is missing", () => {
    expect(loadConfig("/tmp/definitely-not-a-real-config-xyzzy.yml")).toEqual(
      {},
    );
  });

  it("parses a top-level mapping", () => {
    const tmp = createTestDataDir();
    try {
      const path = resolve(tmp.dir, "ok.yml");
      writeFileSync(path, "port: 4000\nhost: 127.0.0.1\n");
      const cfg = loadConfig(path);
      expect(cfg.port).toBe(4000);
      expect(cfg.host).toBe("127.0.0.1");
    } finally {
      tmp.cleanup();
    }
  });

  it("returns {} for an empty file", () => {
    const tmp = createTestDataDir();
    try {
      const path = resolve(tmp.dir, "empty.yml");
      writeFileSync(path, "");
      expect(loadConfig(path)).toEqual({});
    } finally {
      tmp.cleanup();
    }
  });

  it("throws on a top-level array", () => {
    const tmp = createTestDataDir();
    try {
      const path = resolve(tmp.dir, "array.yml");
      writeFileSync(path, "- one\n- two\n");
      expect(() => loadConfig(path)).toThrow("expected a mapping");
    } finally {
      tmp.cleanup();
    }
  });

  it("throws on a top-level scalar", () => {
    const tmp = createTestDataDir();
    try {
      const path = resolve(tmp.dir, "scalar.yml");
      writeFileSync(path, "just-a-string\n");
      expect(() => loadConfig(path)).toThrow("expected a mapping");
    } finally {
      tmp.cleanup();
    }
  });

  it("supports nested values", () => {
    const tmp = createTestDataDir();
    try {
      const path = resolve(tmp.dir, "nested.yml");
      writeFileSync(path, "search:\n  chunk_size: 256\n  weight: 0.7\n");
      const cfg = loadConfig(path) as { search: Record<string, number> };
      expect(cfg.search.chunk_size).toBe(256);
      expect(cfg.search.weight).toBe(0.7);
    } finally {
      tmp.cleanup();
    }
  });
});
