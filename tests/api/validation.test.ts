import { describe, expect, it } from "bun:test";

/**
 * Tests for the request body validation helpers used in src/routes/api.ts.
 * Inlined to avoid pulling in the full Elysia/api stack.
 */

function asObject(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("Invalid request body: expected JSON object");
  }
  return body as Record<string, unknown>;
}

function requireString(body: Record<string, unknown>, key: string): string {
  const v = body[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`Invalid request: '${key}' must be a non-empty string`);
  }
  return v;
}

function requireArray(body: Record<string, unknown>, key: string): unknown[] {
  const v = body[key];
  if (!Array.isArray(v)) {
    throw new Error(`Invalid request: '${key}' must be an array`);
  }
  return v;
}

describe("asObject", () => {
  it("returns the object when given a plain object", () => {
    expect(asObject({ a: 1 })).toEqual({ a: 1 });
  });

  it("throws on null", () => {
    expect(() => asObject(null)).toThrow("expected JSON object");
  });

  it("throws on undefined", () => {
    expect(() => asObject(undefined)).toThrow("expected JSON object");
  });

  it("throws on arrays", () => {
    expect(() => asObject([1, 2, 3])).toThrow("expected JSON object");
  });

  it("throws on strings", () => {
    expect(() => asObject("hello")).toThrow("expected JSON object");
  });

  it("throws on numbers", () => {
    expect(() => asObject(42)).toThrow("expected JSON object");
  });
});

describe("requireString", () => {
  it("returns the value when present and non-empty", () => {
    expect(requireString({ wiki: "myproj" }, "wiki")).toBe("myproj");
  });

  it("throws on missing key", () => {
    expect(() => requireString({}, "wiki")).toThrow("'wiki' must be");
  });

  it("throws on empty string", () => {
    expect(() => requireString({ wiki: "" }, "wiki")).toThrow();
  });

  it("throws on number", () => {
    expect(() => requireString({ wiki: 42 }, "wiki")).toThrow();
  });

  it("throws on null", () => {
    expect(() => requireString({ wiki: null }, "wiki")).toThrow();
  });
});

describe("requireArray", () => {
  it("returns an array when present", () => {
    expect(requireArray({ files: [1, 2] }, "files")).toEqual([1, 2]);
  });

  it("returns empty arrays", () => {
    expect(requireArray({ files: [] }, "files")).toEqual([]);
  });

  it("throws on missing key", () => {
    expect(() => requireArray({}, "files")).toThrow("'files' must be an array");
  });

  it("throws on object", () => {
    expect(() => requireArray({ files: { a: 1 } }, "files")).toThrow();
  });

  it("throws on string", () => {
    expect(() => requireArray({ files: "not array" }, "files")).toThrow();
  });
});
