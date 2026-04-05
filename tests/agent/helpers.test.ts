import { describe, expect, it } from "bun:test";

/**
 * Tests for agent helper functions (slugify, extractMarkdown).
 * Inlined here to avoid importing agent.ts which has heavy dependencies.
 */

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function extractMarkdown(content: string): string | null {
  if (!content.trim()) return null;
  const fenced = content.match(/^```(?:markdown|md)?\n([\s\S]*?)\n```$/m);
  if (fenced) return fenced[1].trim();
  return content.trim();
}

describe("slugify", () => {
  it("lowercases and replaces spaces with hyphens", () => {
    expect(slugify("API Reference")).toBe("api-reference");
  });

  it("strips leading/trailing hyphens", () => {
    expect(slugify("--hello--")).toBe("hello");
  });

  it("collapses multiple special chars into one hyphen", () => {
    expect(slugify("Getting   Started!!!")).toBe("getting-started");
  });

  it("handles single words", () => {
    expect(slugify("Overview")).toBe("overview");
  });

  it("handles numbers", () => {
    expect(slugify("Step 2 Setup")).toBe("step-2-setup");
  });
});

describe("extractMarkdown", () => {
  it("returns null for empty content", () => {
    expect(extractMarkdown("")).toBeNull();
    expect(extractMarkdown("   ")).toBeNull();
  });

  it("strips markdown code fences", () => {
    const input = "```markdown\n# Hello\n\nWorld\n```";
    expect(extractMarkdown(input)).toBe("# Hello\n\nWorld");
  });

  it("strips md code fences", () => {
    const input = "```md\n# Hello\n```";
    expect(extractMarkdown(input)).toBe("# Hello");
  });

  it("returns plain content as-is", () => {
    expect(extractMarkdown("# Hello")).toBe("# Hello");
  });

  it("trims whitespace", () => {
    expect(extractMarkdown("  # Hello  ")).toBe("# Hello");
  });
});
