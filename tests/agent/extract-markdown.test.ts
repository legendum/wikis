import { describe, expect, it } from "bun:test";
import { extractMarkdown, slugify } from "../../src/lib/agent/helpers";

/**
 * Tests for extractMarkdown and slugify pulled from the real module
 * (helpers.ts has no transitive heavy dependencies — only bun:sqlite types).
 */

describe("extractMarkdown (real)", () => {
  it("returns null for empty content", () => {
    expect(extractMarkdown("")).toBeNull();
    expect(extractMarkdown("   \n  ")).toBeNull();
  });

  it("returns plain markdown unchanged", () => {
    expect(extractMarkdown("# Hello\n\nWorld")).toBe("# Hello\n\nWorld");
  });

  it("strips ```markdown fence", () => {
    expect(extractMarkdown("```markdown\n# Hello\n```")).toBe("# Hello");
  });

  it("strips ```md fence", () => {
    expect(extractMarkdown("```md\n# Hello\n```")).toBe("# Hello");
  });

  it("strips bare ``` fence", () => {
    expect(extractMarkdown("```\n# Hello\n```")).toBe("# Hello");
  });

  it("preserves inner code fences", () => {
    const input = "```markdown\n# Title\n\n```js\nconsole.log()\n```\n```";
    const out = extractMarkdown(input);
    expect(out).toContain("```js");
    expect(out).toContain("console.log()");
  });

  it("trims surrounding whitespace", () => {
    expect(extractMarkdown("  \n# Hello\n  ")).toBe("# Hello");
  });

  it("does not strip mid-line backticks", () => {
    expect(extractMarkdown("Use `foo` here")).toBe("Use `foo` here");
  });
});

describe("slugify (real)", () => {
  it("lowercases and hyphenates", () => {
    expect(slugify("API Reference")).toBe("api-reference");
  });

  it("collapses runs of special chars", () => {
    expect(slugify("Hello,   World!!!")).toBe("hello-world");
  });

  it("strips leading/trailing hyphens", () => {
    expect(slugify("---foo---")).toBe("foo");
  });

  it("preserves digits", () => {
    expect(slugify("Step 2 — Setup")).toBe("step-2-setup");
  });

  it("handles unicode by stripping it", () => {
    expect(slugify("café résumé")).toBe("caf-r-sum");
  });

  it("returns empty string for all-special input", () => {
    expect(slugify("!!!")).toBe("");
  });
});
