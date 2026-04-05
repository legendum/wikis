/**
 * Web routes — server-rendered wiki pages via Eta templates.
 * Handles both public wikis (unauthenticated) and private wikis (authenticated).
 */
import { Elysia, type Context } from "elysia";
import { Database } from "bun:sqlite";
import { getPublicDb, getUserDb } from "../lib/db";
import { getFile, listFiles, getPageUpdates } from "../lib/storage";
import { search } from "../lib/search";
import { extractBearerToken, validateAccountKey } from "../lib/auth";
import { getSessionUser } from "./auth";
import { CONTENT_TYPE_MARKDOWN_UTF8, LEGENDUM_BASE_URL } from "../lib/constants";

/** Line that starts a typical markdown block (heading, list, quote, table, hr). */
function looksLikeMarkdownBlockStart(line: string): boolean {
  const t = line.trimStart();
  if (/^#{1,6}\s/.test(t)) return true;
  if (/^[-*+]\s/.test(t)) return true;
  if (/^\d+\.\s/.test(t)) return true;
  if (/^>\s/.test(t)) return true;
  if (/^\|/.test(t)) return true;
  if (/^([-*_])\s*\1\s*\1\s*$/.test(t.trim())) return true;
  return false;
}

/**
 * Multi-word prose line (common when models end a fence with a blank line then a sentence).
 * Avoids treating `const x` or single identifiers as prose.
 */
function looksLikeProseAfterCodeBlank(line: string): boolean {
  const t = line.trimStart();
  if (t.length < 4) return false;
  if (!/^[A-Za-z]/.test(t)) return false;
  if (!/\s/.test(t)) return false;
  if (/^(const|let|var|function|class|import|export|return|if|for|while|switch|case|default|async|await|interface|type|enum|namespace|def|fn|pub|use|mod|struct|trait|impl|package)\b/.test(t)) {
    return false;
  }
  return true;
}

/**
 * Extract fenced code blocks. Supports closing ``` and a fallback when models omit it: a blank
 * line followed by a new markdown block or obvious prose (AI docs often use only a blank line).
 */
function extractFencedCodeBlocks(md: string): { processed: string; codeBlocks: string[] } {
  const lines = md.split("\n");
  const out: string[] = [];
  const codeBlocks: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const open = lines[i].match(/^```(\w*)\s*$/);
    if (!open) {
      out.push(lines[i]);
      i++;
      continue;
    }

    const lang = open[1] ?? "";
    const openingLine = lines[i];
    i++;

    const codeLines: string[] = [];
    let explicitClose = false;

    while (i < lines.length) {
      const line = lines[i];
      if (/^\s*```\s*$/.test(line)) {
        explicitClose = true;
        i++;
        break;
      }
      if (
        line === "" &&
        i + 1 < lines.length &&
        lines[i + 1] !== "" &&
        codeLines.length > 0
      ) {
        const next = lines[i + 1];
        if (looksLikeMarkdownBlockStart(next) || looksLikeProseAfterCodeBlank(next)) {
          break;
        }
      }
      codeLines.push(line);
      i++;
    }

    const rawCode = codeLines.join("\n");
    const trimmed = rawCode.trim();
    if (!trimmed) {
      out.push(openingLine);
      for (const cl of codeLines) out.push(cl);
      if (explicitClose) out.push("```");
      continue;
    }

    const idx = codeBlocks.length;
    codeBlocks.push(`<pre><code class="language-${lang || "text"}">${escapeHtml(trimmed)}</code></pre>`);
    out.push(`%%CODEBLOCK_${idx}%%`);
  }

  return { processed: out.join("\n"), codeBlocks };
}

// Simple markdown → HTML (basic for now — headings, links, code, paragraphs)
function renderMarkdown(md: string, project?: string): string {
  // Phase 1: extract code blocks into placeholders
  const { processed: mdWithoutFences, codeBlocks } = extractFencedCodeBlocks(md);
  let processed = mdWithoutFences;

  // Phase 2: inline formatting
  processed = processed
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/^#### (.+)$/gm, "<h4>$1</h4>")
    .replace(/^### (.+)$/gm, "<h3>$1</h3>")
    .replace(/^## (.+)$/gm, "<h2>$1</h2>")
    .replace(/^# (.+)$/gm, '<h1><img src="/public/wikis.png" alt="" class="page-logo">$1</h1>')
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    // Images (before links so ![...](...) isn't caught by link regex)
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1">')
    // Wiki .md links
    .replace(/\[([^\]]+)\]\(([^/)][^)]*?)\.md\)/g, (_, text, slug) =>
      `<a href="/${project || ""}/${slug}">${text}</a>`)
    // External links
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2">$1</a>')
    // Bare wiki links like [page-name.md] (no round brackets)
    .replace(/\[([^\]]+?)\.md\](?!\()/g, (_, slug) => {
      const title = slug.replace(/-/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase());
      return `<a href="/${project || ""}/${slug}">${title}</a>`;
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
    if (line.startsWith("|") && i + 1 < lines.length && /^\|[-| :]+\|$/.test(lines[i + 1])) {
      const headers = line.split("|").filter(Boolean).map((h: string) => `<th>${h.trim()}</th>`).join("");
      i += 2; // skip header + separator
      const rows: string[] = [];
      while (i < lines.length && lines[i].startsWith("|")) {
        const cells = lines[i].split("|").filter(Boolean).map((c: string) => `<td>${c.trim()}</td>`).join("");
        rows.push(`<tr>${cells}</tr>`);
        i++;
      }
      out.push(`<table><thead><tr>${headers}</tr></thead><tbody>${rows.join("")}</tbody></table>`);
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

  function build(items: { indent: number; text: string }[], idx: number, baseIndent: number): { html: string; next: number } {
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

interface PageOpts {
  nav?: string;
  searchQuery?: string;
  loggedIn?: boolean;
  balance?: number | null;
  hideSearch?: boolean;
}

function htmlPage(title: string, body: string, opts: PageOpts = {}): string {
  const creditsUrl = `${LEGENDUM_BASE_URL}/account`;
  const balancePill = opts.balance != null
    ? `<span class="icon">&#x2C60; ${opts.balance.toLocaleString()}</span> `
    : `<span class="icon">&#x2C60;</span> `;
  const loginLink = opts.loggedIn
    ? `<a href="${creditsUrl}" target="_blank" class="login">${balancePill}Buy Credits</a>`
    : `<a href="/login" class="login"><span class="icon">&#x2C60;</span> Log in with Legendum</a>`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
  <meta name="description" content="Personal AI-generated wikis for your projects.">
  <meta name="theme-color" content="#0066cc">
  <meta property="og:title" content="${title} — wikis.fyi">
  <meta property="og:description" content="Personal AI-generated wikis for your projects.">
  <meta property="og:type" content="website">
  <meta property="og:url" content="https://wikis.fyi">
  <meta property="og:image" content="https://wikis.fyi/public/wikis.png">
  <meta name="twitter:card" content="summary">
  <title>${title} — wikis.fyi</title>
  <link rel="icon" type="image/png" href="/public/wikis.png">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;600;700&display=swap">
  <link rel="stylesheet" href="/public/style.css">
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/themes/prism-tomorrow.min.css">
</head>
<body>
  <header>
    <nav>
      <span><a href="/">Wikis</a>${opts.nav || ""}</span>
      ${loginLink}
    </nav>
    ${opts.hideSearch ? "" : `<form class="search" method="get">
      <input type="text" name="q" placeholder="Search..." value="${escapeHtml(opts.searchQuery || "")}" aria-label="Search" autocomplete="off">
      <div class="search-results" hidden></div>
    </form>`}
  </header>
  <main>${body}</main>
  <footer><p>Powered by <a href="https://legendum.co.uk">Legendum</a></p></footer>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/prism.min.js"></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/components/prism-typescript.min.js"></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/components/prism-bash.min.js"></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/components/prism-json.min.js"></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/components/prism-yaml.min.js"></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/components/prism-sql.min.js"></script>
  <script>
  (function(){
    var input = document.querySelector('.search input[name=q]');
    var box = document.querySelector('.search-results');
    if (!input || !box) return;
    var timer = null;
    input.addEventListener('input', function(){
      clearTimeout(timer);
      var q = input.value.trim();
      if (q.length < 2) { box.hidden = true; return; }
      timer = setTimeout(function(){
        fetch(location.pathname + '?q=' + encodeURIComponent(q), { headers: { Accept: 'text/html' } })
          .then(function(r){ return r.text(); })
          .then(function(html){
            var doc = new DOMParser().parseFromString(html, 'text/html');
            var ul = doc.querySelector('main ul');
            if (ul) { box.innerHTML = ul.outerHTML; box.hidden = false; }
            else { box.hidden = true; }
          });
      }, 500);
    });
    input.addEventListener('keydown', function(e){
      if (e.key === 'Escape') { box.hidden = true; input.blur(); }
    });
    document.addEventListener('click', function(e){
      if (!e.target.closest('.search')) box.hidden = true;
    });
  })();
  </script>
</body>
</html>`;
}

export const webRoutes = new Elysia()

  // Landing page — alphabetical wiki index
  .get("/", async ({ headers, query }) => {
    const user = resolveUser(headers);
    const balance = user ? await fetchBalance(user.id) : null;

    const publicDb = getPublicDb();
    const publicWikis = publicDb.prepare("SELECT name, description FROM wikis WHERE visibility = 'public' ORDER BY name").all() as { name: string; description: string }[];

    let userWikis: { name: string; description: string }[] = [];
    if (user) {
      const db = getUserDb(user.id);
      userWikis = db.prepare("SELECT name, description FROM wikis ORDER BY name").all() as { name: string; description: string }[];
    }

    // Search user's wikis only (public wikis have per-wiki search)
    if (query.q && user) {
      const allResults: { wiki: string; path: string; slug: string; title: string; chunk: string }[] = [];
      const db = getUserDb(user.id);
      for (const w of userWikis) {
        const wikiRow = db.prepare("SELECT id FROM wikis WHERE name = ?").get(w.name) as { id: number } | null;
        if (!wikiRow) continue;
        const results = await search(db, wikiRow.id, query.q, { limit: 10 });
        for (const r of results) {
          const slug = r.path.replace(/\.md$/, "");
          const title = slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
          allResults.push({ wiki: w.name, path: r.path, slug, title, chunk: r.chunk });
        }
      }

      const html = allResults
        .map((r) => `<li><a href="/${r.wiki}/${r.slug}"><strong>${r.wiki} / ${r.title}</strong> — ${escapeHtml(snippet(r.chunk))}</a></li>`)
        .join("\n");
      return new Response(
        htmlPage("Search", `<h1>Search: ${escapeHtml(query.q)}</h1><ul>${html || "<li>No results</li>"}</ul>`, { searchQuery: query.q, loggedIn: !!user, balance }),
        { headers: { "Content-Type": "text/html" } }
      );
    }

    function wikiList(wikis: { name: string; description: string }[]) {
      return wikis.map((w) => {
        const desc = w.description ? ` — ${escapeHtml(w.description)}` : "";
        return `<li><a href="/${w.name}">${w.name}</a>${desc}</li>`;
      }).join("\n");
    }

    let body = `<h1><img src="/public/wikis.png" alt="" class="page-logo">Your Wikis</h1>`;

    if (user) {
      const list = wikiList(userWikis);
      body += `<ul>${list || '<li>No wikis yet. Install with <code>curl -fsSL https://wikis.fyi/public/install.sh | sh</code> then run <code>wikis init</code> in a project.</li>'}</ul>`;
    } else {
      body += `<p>To manage your own AI-generated wikis, <a href="/login">log in with Legendum</a> then create an Account Key.</p>`;
    }

    body += `<h1 style="margin-top:2em"><img src="/public/wikis.png" alt="" class="page-logo">Public Wikis</h1>`;
    if (publicWikis.length > 0) {
      body += `<ul>${wikiList(publicWikis)}</ul>`;
    } else {
      body += `<ul><li>Coming soon</li></ul>`;
    }

    return new Response(
      htmlPage("Wikis", body, { loggedIn: !!user, balance, hideSearch: !user }),
      { headers: { "Content-Type": "text/html" } }
    );
  })

  // Wiki page routes: /{project}, /{project}/{path...}
  .get("/:project", ({ params, query, headers, set }) => {
    // /depends or /depends.md both serve index.md
    const name = params.project.replace(/\.md$/, "");
    const wantMd = params.project.endsWith(".md");
    return serveWikiPage(name, wantMd ? "index.md" : "", query, headers, set);
  })
  .get("/:project/*", ({ params, query, headers, set }) => {
    const rest = params["*"];
    return serveWikiPage(params.project, rest, query, headers, set);
  });

async function serveWikiPage(
  project: string,
  rawPath: string,
  query: Record<string, string>,
  headers: Record<string, string | undefined>,
  set: Context["set"],
) {
  const wantMarkdown = rawPath.endsWith(".md");
  let loggedIn = false;
  let balance: number | null = null;

  // Resolve DB — check user first, then public
  const user = resolveUser(headers);
  let db: Database;
  let wiki: { id: number } | null = null;

  if (user) {
    loggedIn = true;
    balance = await fetchBalance(user.id);
    db = getUserDb(user.id);
    wiki = db.prepare("SELECT id FROM wikis WHERE name = ?").get(project) as { id: number } | null;
  }

  if (!wiki) {
    const publicDb = getPublicDb();
    wiki = publicDb.prepare("SELECT id FROM wikis WHERE name = ? AND visibility = 'public'").get(project) as { id: number } | null;
    if (wiki) {
      db = publicDb;
    }
  }

  if (!wiki) {
    set.status = 404;
    return new Response(htmlPage("Not Found", notFoundBody("This wiki doesn't exist."), { loggedIn, balance }), { headers: { "Content-Type": "text/html" } });
  }

  // Handle search
  if (query.q) {
    const results = await search(db, wiki.id, query.q, { limit: 20 });
    if (wantMarkdown) {
      const md = results.map((r) => `- [${r.path}](/${project}/${r.path}): ${r.chunk.slice(0, 100)}...`).join("\n");
      return new Response(`# Search: ${query.q}\n\n${md || "No results."}`, {
        headers: { "Content-Type": CONTENT_TYPE_MARKDOWN_UTF8 },
      });
    }
    const html = results
      .map((r) => {
        const slug = r.path.replace(/\.md$/, "");
        const title = slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
        return `<li><a href="/${project}/${slug}"><strong>${title}</strong> — ${escapeHtml(snippet(r.chunk))}</a></li>`;
      })
      .join("\n");
    const navSearch = ` / <a href="/${project}">${project}</a> / <strong>Search</strong>`;
    return new Response(
      htmlPage(`Search: ${query.q}`, `<h1>Search: ${escapeHtml(query.q)}</h1><ul>${html || "<li>No results</li>"}</ul>`, { nav: navSearch, searchQuery: query.q, loggedIn, balance }),
      { headers: { "Content-Type": "text/html" } }
    );
  }

  // Resolve file path — flat structure, no pages/ prefix
  let filePath: string;
  const slug = wantMarkdown ? rawPath.replace(/\.md$/, "") : rawPath;
  if (slug === "" || slug === "index") {
    filePath = "index.md";
  } else {
    filePath = `${slug}.md`;
  }

  const file = getFile(db, wiki.id, filePath);
  if (!file || !file.content) {
    set.status = 404;
    if (wantMarkdown) {
      return new Response("# Not Found\n", { headers: { "Content-Type": CONTENT_TYPE_MARKDOWN_UTF8 } });
    }
    return new Response(htmlPage("Not Found", notFoundBody("This page doesn't exist yet."), { loggedIn, balance }), { headers: { "Content-Type": "text/html" } });
  }

  if (wantMarkdown) {
    return new Response(file.content, { headers: { "Content-Type": CONTENT_TYPE_MARKDOWN_UTF8 } });
  }

  // Render HTML
  const pageSlug = file.path.replace(".md", "");
  const pageTitle = pageSlug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  const projectTitle = project.charAt(0).toUpperCase() + project.slice(1);
  const isIndex = file.path === "index.md";
  const nav = isIndex
    ? ` / <strong>${projectTitle}</strong>`
    : ` / <a href="/${project}">${projectTitle}</a> / <strong>${pageTitle}</strong>`;
  const title = isIndex ? projectTitle : `${projectTitle} / ${pageTitle}`;
  const body = renderMarkdown(file.content, project);
  const updates = getPageUpdates(db, wiki.id, filePath);
  const updatesHtml = updates.length > 0
    ? `<details class="page-updates"><summary>Recent changes</summary><ul>${updates.map((u) => `<li><time>${u.created_at}</time> ${escapeHtml(u.summary)}</li>`).join("")}</ul></details>`
    : "";
  return new Response(
    htmlPage(title, body + updatesHtml, { nav, loggedIn, balance }),
    { headers: { "Content-Type": "text/html" } }
  );
}

/** Truncate plain text for search result snippets. */
function snippet(text: string, max = 150): string {
  const clean = text.replace(/\n/g, " ").replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const cut = clean.lastIndexOf(" ", max);
  return clean.slice(0, cut > 0 ? cut : max) + "…";
}

async function fetchBalance(userId: number): Promise<number | null> {
  try {
    const { getUserById } = await import("../lib/db");
    const user = getUserById(userId);
    if (!user?.legendum_token) return null;
    const mod = await import("../lib/legendum.js");
    const legendum = mod.default || mod;
    if (!legendum.isConfigured()) return null;
    const data = await legendum.balance(user.legendum_token);
    return data.balance ?? null;
  } catch {
    return null;
  }
}

/** Resolve the current user from cookies — session cookie or account key cookie. */
function resolveUser(headers: Record<string, string | undefined>): { id: number } | null {
  const cookie = headers.cookie;
  // Check API Bearer token first (CLI)
  const bearerToken = extractBearerToken(headers.authorization);
  if (bearerToken) return validateAccountKey(bearerToken);

  if (!cookie) return null;

  // Check session cookie (web login)
  const sessionMatch = cookie.match(/wikis_session=([^;]+)/);
  if (sessionMatch) {
    const userId = getSessionUser(sessionMatch[1]);
    if (userId) return { id: userId };
  }

  // Fallback: account key cookie
  const tokenMatch = cookie.match(/wikis_token=([^;]+)/);
  if (tokenMatch) return validateAccountKey(tokenMatch[1]);

  return null;
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function notFoundBody(message: string): string {
  return `<div class="not-found">
  <h1>404</h1>
  <p>${message}</p>
  <a href="/">Back to Wikis</a>
</div>`;
}
