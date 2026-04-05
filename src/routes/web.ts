/**
 * Web routes — server-rendered wiki pages via Eta templates.
 * Handles both public wikis (unauthenticated) and private wikis (authenticated).
 */
import { Elysia } from "elysia";
import { getPublicDb, getUserDb } from "../lib/db";
import { getFile, listFiles } from "../lib/storage";
import { searchFts } from "../lib/search";
import { extractBearerToken, validateAccountKey } from "../lib/auth";
import { getSessionUser } from "./auth";
import { LEGENDUM_BASE_URL } from "../lib/constants";

// Simple markdown → HTML (basic for now — headings, links, code, paragraphs)
function renderMarkdown(md: string, project?: string): string {
  // Phase 1: extract code blocks into placeholders (before any other processing)
  // Match both closed (```...```) and unclosed (```...EOF) fences
  const codeBlocks: string[] = [];
  let processed = md.replace(/```(\w*)\n?([\s\S]*?)(?:```|$)/g, (match, lang, code) => {
    // Skip if this doesn't look like a real code fence (no content)
    if (!code.trim()) return match;
    const idx = codeBlocks.length;
    codeBlocks.push(`<pre><code class="language-${lang || "text"}">${escapeHtml(code.trim())}</code></pre>`);
    return `\n%%CODEBLOCK_${idx}%%\n`;
  });

  processed = processed
    // Inline code
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    // Headings
    .replace(/^### (.+)$/gm, "<h3>$1</h3>")
    .replace(/^## (.+)$/gm, "<h2>$1</h2>")
    .replace(/^# (.+)$/gm, "<h1>$1</h1>")
    // Bold
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    // Italic
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    // Wiki .md links — foo.md → /{project}/foo
    .replace(/\[([^\]]+)\]\(([^/)][^)]*?)\.md\)/g, (_, text, slug) =>
      `<a href="/${project || ""}/${slug}">${text}</a>`)
    // External links (already absolute)
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2">$1</a>')
    // List items
    .replace(/^- (.+)$/gm, "<li>$1</li>")
    .replace(/(<li>.*<\/li>\n?)+/g, "<ul>$&</ul>")
    // Tables
    .replace(/^(\|.+\|)\n\|[-| :]+\|\n((?:\|.+\|\n?)+)/gm, (_, headerRow, bodyRows) => {
      const headers = headerRow.split("|").filter(Boolean).map((h: string) => `<th>${h.trim()}</th>`).join("");
      const rows = bodyRows.trim().split("\n").map((row: string) => {
        const cells = row.split("|").filter(Boolean).map((c: string) => `<td>${c.trim()}</td>`).join("");
        return `<tr>${cells}</tr>`;
      }).join("");
      return `<table><thead><tr>${headers}</tr></thead><tbody>${rows}</tbody></table>`;
    })
    // Paragraphs (lines not already wrapped, not placeholders, not table tags)
    .replace(/^(?!<[huplo\t])(?!%%CODEBLOCK)(.*\S.*)$/gm, "<p>$1</p>")
    // Horizontal rules
    .replace(/^---$/gm, "<hr>");

  // Phase 2: restore code blocks
  for (let i = 0; i < codeBlocks.length; i++) {
    processed = processed.replace(`%%CODEBLOCK_${i}%%`, codeBlocks[i]);
  }

  return processed;
}

interface PageOpts {
  nav?: string;
  searchQuery?: string;
  loggedIn?: boolean;
}

function htmlPage(title: string, body: string, opts: PageOpts = {}): string {
  const creditsUrl = `${LEGENDUM_BASE_URL}/account`;
  const loginLink = opts.loggedIn
    ? `<a href="${creditsUrl}" target="_blank" class="login"><span class="icon">&#x2C60;</span> Buy Credits</a>`
    : `<a href="/login" class="login"><span class="icon">&#x2C60;</span> Log in with Legendum</a>`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} — wikis.fyi</title>
  <link rel="stylesheet" href="/public/style.css">
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/themes/prism-tomorrow.min.css">
</head>
<body>
  <header>
    <nav>
      <span><a href="/">Wikis</a>${opts.nav || ""}</span>
      ${loginLink}
    </nav>
    <form class="search" method="get">
      <input type="text" name="q" placeholder="Search..." value="${escapeHtml(opts.searchQuery || "")}" aria-label="Search" autocomplete="off">
      <div class="search-results" hidden></div>
    </form>
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
      }, 300);
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
  .get("/", ({ headers, query }) => {
    const user = resolveUser(headers);

    // Signed in: show user's private wikis
    // Not signed in: show public wikis
    const db = user ? getUserDb(user.id) : getPublicDb();
    const where = user ? "" : "WHERE visibility = 'public'";
    const wikis = db.prepare(`SELECT name, description, created_at FROM wikis ${where} ORDER BY name`).all() as { name: string; description: string; created_at: string }[];

    // Global search across all visible wikis
    if (query.q) {
      const allResults: { wiki: string; path: string; slug: string; title: string; chunk: string }[] = [];
      for (const w of wikis) {
        const wikiRow = db.prepare("SELECT id FROM wikis WHERE name = ?").get(w.name) as { id: number } | null;
        if (!wikiRow) continue;
        const results = searchFts(db, query.q, { limit: 10 });
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
        htmlPage("Search", `<h1>Search: ${escapeHtml(query.q)}</h1><ul>${html || "<li>No results</li>"}</ul>`, { searchQuery: query.q, loggedIn: !!user }),
        { headers: { "Content-Type": "text/html" } }
      );
    }

    const heading = user ? "Your Wikis" : "Wikis";
    const subtitle = user ? "" : "<p>Personal wikis powered by LLMs.</p>";
    const empty = user
      ? "<li>No wikis yet. Run <code>wikis init</code> in a project.</li>"
      : "<li>Coming soon</li>";
    const list = wikis.map((w) => {
      const desc = w.description ? ` — ${escapeHtml(w.description)}` : "";
      return `<li><a href="/${w.name}">${w.name}</a>${desc}</li>`;
    }).join("\n");

    return new Response(
      htmlPage("Wikis", `<h1>${heading}</h1>${subtitle}<ul>${list || empty}</ul>`, { loggedIn: !!user }),
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

function serveWikiPage(
  project: string,
  rawPath: string,
  query: Record<string, string>,
  headers: Record<string, string | undefined>,
  set: any
) {
  const wantMarkdown = rawPath.endsWith(".md");
  let loggedIn = false;

  // Resolve DB — check public first, then private
  const publicDb = getPublicDb();
  let wiki = publicDb.prepare("SELECT id FROM wikis WHERE name = ? AND visibility = 'public'").get(project) as { id: number } | null;
  let db = publicDb;

  if (!wiki) {
    const user = resolveUser(headers);

    if (!user) {
      set.status = 404;
      return new Response(htmlPage("Not Found", "<h1>Wiki not found</h1>"), { headers: { "Content-Type": "text/html" } });
    }

    loggedIn = true;
    db = getUserDb(user.id);
    wiki = db.prepare("SELECT id FROM wikis WHERE name = ?").get(project) as { id: number } | null;
    if (!wiki) {
      set.status = 404;
      return new Response(htmlPage("Not Found", "<h1>Wiki not found</h1>", { loggedIn }), { headers: { "Content-Type": "text/html" } });
    }
  }

  // Handle search
  if (query.q) {
    const results = searchFts(db, query.q, { limit: 20 });
    if (wantMarkdown) {
      const md = results.map((r) => `- [${r.path}](/${project}/${r.path}): ${r.chunk.slice(0, 100)}...`).join("\n");
      return new Response(`# Search: ${query.q}\n\n${md || "No results."}`, {
        headers: { "Content-Type": "text/markdown" },
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
      htmlPage(`Search: ${query.q}`, `<h1>Search: ${escapeHtml(query.q)}</h1><ul>${html || "<li>No results</li>"}</ul>`, { nav: navSearch, searchQuery: query.q, loggedIn }),
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
      return new Response("# Not Found\n", { headers: { "Content-Type": "text/markdown" } });
    }
    return new Response(htmlPage("Not Found", "<h1>Page not found</h1>", { loggedIn }), { headers: { "Content-Type": "text/html" } });
  }

  if (wantMarkdown) {
    return new Response(file.content, { headers: { "Content-Type": "text/markdown" } });
  }

  // Render HTML
  const pageSlug = file.path.replace(".md", "");
  const pageTitle = pageSlug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  const projectTitle = project.replace(/\b\w/g, (c) => c.toUpperCase());
  const isIndex = file.path === "index.md";
  const nav = isIndex
    ? ` / <strong>${projectTitle}</strong>`
    : ` / <a href="/${project}">${projectTitle}</a> / <strong>${pageTitle}</strong>`;
  const title = isIndex ? projectTitle : `${projectTitle} / ${pageTitle}`;
  const body = renderMarkdown(file.content, project);
  return new Response(
    htmlPage(title, body, { nav, loggedIn }),
    { headers: { "Content-Type": "text/html" } }
  );
}

/** Resolve the current user from cookies — session cookie or account key cookie. */
function snippet(text: string, max = 150): string {
  const clean = text.replace(/\n/g, " ").replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const cut = clean.lastIndexOf(" ", max);
  return clean.slice(0, cut > 0 ? cut : max) + "…";
}

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
