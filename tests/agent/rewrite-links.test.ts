import { describe, expect, it } from "bun:test";

/**
 * Tests for the link rewriting regex used by consolidate.ts when merging
 * or removing wiki pages. The regex must:
 *  - rewrite [text](old.md) to [text](new.md)
 *  - rewrite bare [old.md] (without a following parenthetical) to [new.md]
 *  - not touch [text](old.md.bak) or [old.md.bak]
 *  - escape special regex characters in old paths
 */

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function rewriteLinks(
  content: string,
  oldPath: string,
  newPath: string,
): string {
  const linkPattern = new RegExp(
    `(\\[[^\\]]*\\])\\(${escapeRegex(oldPath)}\\)|\\[${escapeRegex(oldPath)}\\](?!\\()`,
    "g",
  );
  return content.replace(linkPattern, (_match, linkText) => {
    if (linkText) return `${linkText}(${newPath})`;
    return `[${newPath}]`;
  });
}

describe("rewriteLinks", () => {
  it("rewrites markdown links", () => {
    const out = rewriteLinks("See [docs](old.md) here", "old.md", "new.md");
    expect(out).toBe("See [docs](new.md) here");
  });

  it("rewrites bare bracket references", () => {
    const out = rewriteLinks("See [old.md]", "old.md", "new.md");
    expect(out).toBe("See [new.md]");
  });

  it("rewrites multiple occurrences in one pass", () => {
    const out = rewriteLinks("[a](old.md) and [b](old.md)", "old.md", "new.md");
    expect(out).toBe("[a](new.md) and [b](new.md)");
  });

  it("does not touch [old.md] when followed by ( — that's a real link", () => {
    // [old.md](other.md) should not be rewritten as a bare bracket;
    // (the inner part matches the markdown-link arm only if old.md is the target)
    const out = rewriteLinks("[old.md](other.md)", "old.md", "new.md");
    // The bare-bracket arm requires (?!\() so it does NOT match here.
    // The link arm matches `(other.md)` not `(old.md)`, so nothing changes.
    expect(out).toBe("[old.md](other.md)");
  });

  it("does not match different files with shared prefix", () => {
    const out = rewriteLinks("[x](old.md.bak)", "old.md", "new.md");
    expect(out).toBe("[x](old.md.bak)");
  });

  it("escapes regex special characters in old path", () => {
    const out = rewriteLinks("[x](a.b+c.md)", "a.b+c.md", "renamed.md");
    expect(out).toBe("[x](renamed.md)");
  });

  it("returns content unchanged when no match", () => {
    const out = rewriteLinks(
      "plain text [other](other.md)",
      "old.md",
      "new.md",
    );
    expect(out).toBe("plain text [other](other.md)");
  });

  it("handles links with empty text", () => {
    const out = rewriteLinks("[](old.md)", "old.md", "new.md");
    expect(out).toBe("[](new.md)");
  });

  it("rewrites mix of bare and full-link references", () => {
    const input = "See [the doc](old.md), or just [old.md].";
    const out = rewriteLinks(input, "old.md", "new.md");
    expect(out).toBe("See [the doc](new.md), or just [new.md].");
  });
});
