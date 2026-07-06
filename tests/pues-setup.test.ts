import { describe, expect, test } from "bun:test";
import { isUlid, ulid, ulidTime } from "pues/base/core/ulid";

// Smoke test: proves vendored pues core is importable (so the `pues/*` path
// mapping and vendoring worked) and functioning. Imports the pure `ulid`
// module directly, not the `pues/base/core` barrel, so it passes on a fresh
// checkout before `bun install` (the barrel pulls in React). Extend freely.
describe("pues setup", () => {
  test("core ULID helpers are wired", () => {
    const id = ulid();
    expect(isUlid(id)).toBe(true);
    expect(ulidTime(id)).toBeGreaterThan(0);
  });
});
