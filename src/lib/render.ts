/**
 * Pure markdown → HTML rendering. No DB, no Elysia, no auth — safe to import
 * from CLI commands or anywhere else that just needs to turn a `.md` string
 * into HTML using the same flavour the wikis.fyi web routes use.
 *
 * Extracted from src/routes/web.ts so that lightweight consumers (like the
 * `wikis open` local server) don't pull in the full server stack as a
 * transitive dependency.
 */

/** Strip the opening fence's indent from each body line (nested / list-indented ``` blocks). */
function dedentFenceLine(line: string, indent: string): string {
  if (!indent) return line;
  if (line === "") return "";
  if (line.startsWith(indent)) return line.slice(indent.length);
  return line;
}

/**
 * Extract fenced code blocks using explicit ``` only (no implicit termination).
 * Opening fences may be indented; body lines are dedented.
 */
function extractFencedCodeBlocks(md: string): {
  processed: string;
  codeBlocks: string[];
} {
  const lines = md.split("\n");
  const out: string[] = [];
  const codeBlocks: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const open = lines[i].match(/^(\s*)```(\w*)\s*$/);
    if (!open) {
      out.push(lines[i]);
      i++;
      continue;
    }

    const fenceIndent = open[1] ?? "";
    const lang = open[2] ?? "";
    const openingLine = lines[i];
    i++;

    const codeLines: string[] = [];
    const innerRaw: string[] = [];
    let explicitClose = false;

    while (i < lines.length) {
      const line = lines[i];
      if (/^\s*```\s*$/.test(line)) {
        explicitClose = true;
        i++;
        break;
      }
      innerRaw.push(line);
      codeLines.push(dedentFenceLine(line, fenceIndent));
      i++;
    }

    const rawCode = codeLines.join("\n");
    const trimmed = rawCode.trim();
    if (!trimmed) {
      out.push(openingLine);
      for (const rl of innerRaw) out.push(rl);
      if (explicitClose && i > 0) out.push(lines[i - 1]);
      continue;
    }

    const idx = codeBlocks.length;
    const langClass = lang || "text";
    codeBlocks.push(
      `<pre class="language-${langClass}"><code class="language-${langClass}">${escapeHtml(trimmed)}</code></pre>`,
    );
    out.push(`%%CODEBLOCK_${idx}%%`);
  }

  return { processed: out.join("\n"), codeBlocks };
}

/**
 * Simple markdown → HTML (basic — headings, links, code, paragraphs, lists,
 * tables, blockquotes, fenced code blocks).
 *
 * `project` is used to prefix wiki-internal links: `[foo](bar.md)` becomes
 * `<a href="/{project}/bar">foo</a>`. Pass an empty string for the local
 * `wikis open` use case where pages live at the server root.
 */
export function renderMarkdown(md: string, project = ""): string {
  // Phase 1: extract code blocks into placeholders
  const { processed: mdWithoutFences, codeBlocks } =
    extractFencedCodeBlocks(md);
  let processed = mdWithoutFences;

  const linkBase = project ? `/${project}` : "";

  // Phase 2: inline formatting
  processed = processed
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/^#### (.+)$/gm, "<h4>$1</h4>")
    .replace(/^### (.+)$/gm, "<h3>$1</h3>")
    .replace(/^## (.+)$/gm, "<h2>$1</h2>")
    .replace(
      /^# (.+)$/gm,
      '<h1><img src="/public/wikis.png" alt="" class="page-logo">$1</h1>',
    )
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    // Images (before links so ![...](...) isn't caught by link regex)
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1">')
    // Wiki .md links
    .replace(
      /\[([^\]]+)\]\(([^/)][^)]*?)\.md\)/g,
      (_, text, slug) => `<a href="${linkBase}/${slug}">${text}</a>`,
    )
    // External links
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2">$1</a>')
    // Bare wiki links like [page-name.md] (no round brackets)
    .replace(/\[([^\]]+?)\.md\](?!\()/g, (_, slug) => {
      const title = slug
        .replace(/-/g, " ")
        .replace(/\b\w/g, (c: string) => c.toUpperCase());
      return `<a href="${linkBase}/${slug}">${title}</a>`;
    })
    .replace(/^---$/gm, "<hr>");

  // Phase 3: block-level elements (line by line)
  const lines = processed.split("\n");
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Code block placeholder — pass through
    if (line.trim().startsWith("%%CODEBLOCK_")) {
      out.push(line);
      i++;
      continue;
    }

    // Already-processed HTML tags — pass through
    if (/^<(h[1-4]|hr|pre|table|img)/.test(line.trim())) {
      out.push(line);
      i++;
      continue;
    }

    // Blockquotes
    if (/^> /.test(line)) {
      const bqLines: string[] = [];
      while (i < lines.length && /^> ?/.test(lines[i])) {
        bqLines.push(lines[i].replace(/^> ?/, ""));
        i++;
      }
      out.push(`<blockquote>${bqLines.join("<br>")}</blockquote>`);
      continue;
    }

    // Tables
    if (
      line.startsWith("|") &&
      i + 1 < lines.length &&
      /^\|[-| :]+\|$/.test(lines[i + 1])
    ) {
      const headers = line
        .split("|")
        .filter(Boolean)
        .map((h: string) => `<th>${h.trim()}</th>`)
        .join("");
      i += 2; // skip header + separator
      const rows: string[] = [];
      while (i < lines.length && lines[i].startsWith("|")) {
        const cells = lines[i]
          .split("|")
          .filter(Boolean)
          .map((c: string) => `<td>${c.trim()}</td>`)
          .join("");
        rows.push(`<tr>${cells}</tr>`);
        i++;
      }
      out.push(
        `<table><thead><tr>${headers}</tr></thead><tbody>${rows.join("")}</tbody></table>`,
      );
      continue;
    }

    // Unordered lists (with nesting)
    if (/^( *)- /.test(line)) {
      out.push(renderList(lines, i, "ul"));
      while (i < lines.length && /^( *)- /.test(lines[i])) i++;
      continue;
    }

    // Ordered lists (with nesting)
    if (/^( *)\d+\. /.test(line)) {
      out.push(renderList(lines, i, "ol"));
      while (i < lines.length && /^( *)\d+\. /.test(lines[i])) i++;
      continue;
    }

    // Paragraph — non-empty lines not already handled
    if (line.trim()) {
      out.push(`<p>${line.trim()}</p>`);
    }
    i++;
  }

  processed = out.join("\n");

  // Phase 4: restore code blocks
  for (let j = 0; j < codeBlocks.length; j++) {
    processed = processed.replace(`%%CODEBLOCK_${j}%%`, codeBlocks[j]);
  }

  return processed;
}

/** Render a nested list (ul or ol) starting at the given line index. */
function renderList(lines: string[], start: number, tag: "ul" | "ol"): string {
  const pattern = tag === "ul" ? /^( *)- (.+)$/ : /^( *)\d+\. (.+)$/;
  const items: { indent: number; text: string }[] = [];

  let i = start;
  while (i < lines.length) {
    const m = lines[i].match(pattern);
    if (!m) break;
    items.push({ indent: m[1].length, text: m[2] });
    i++;
  }

  function build(
    items: { indent: number; text: string }[],
    idx: number,
    baseIndent: number,
  ): { html: string; next: number } {
    let html = `<${tag}>`;
    let j = idx;
    while (j < items.length && items[j].indent >= baseIndent) {
      if (items[j].indent === baseIndent) {
        html += `<li>${items[j].text}`;
        j++;
        // Check for nested items
        if (j < items.length && items[j].indent > baseIndent) {
          const nested = build(items, j, items[j].indent);
          html += nested.html;
          j = nested.next;
        }
        html += `</li>`;
      } else {
        // Shouldn't happen, but handle gracefully
        const nested = build(items, j, items[j].indent);
        html += nested.html;
        j = nested.next;
      }
    }
    html += `</${tag}>`;
    return { html, next: j };
  }

  return build(items, 0, items[0]?.indent ?? 0).html;
}

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
