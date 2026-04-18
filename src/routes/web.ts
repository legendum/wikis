/**
 * Web routes — server-rendered wiki pages via Eta templates.
 * Handles both public wikis (unauthenticated) and private wikis (authenticated).
 */

import type { Database } from "bun:sqlite";
import { type Context, Elysia } from "elysia";
import {
  extractBearerToken,
  validateAccountKey,
  validateBearerToken,
} from "../lib/auth";
import {
  CONTENT_TYPE_MARKDOWN_UTF8,
  LEGENDUM_BASE_URL,
} from "../lib/constants";
import { ensureLocalUser, getPublicDb, getUserDb } from "../lib/db";
import { highlightCodeBlocks, PRISM_THEME_CSS } from "../lib/highlight";
import { isSelfHosted, LOCAL_USER_ID } from "../lib/mode";
import { escapeHtml, renderMarkdown } from "../lib/render";
import { search, searchAllWikis } from "../lib/search";
import { getFile, getPageUpdates, listFiles } from "../lib/storage";
import { getSessionUser } from "./auth";

/* renderMarkdown / escapeHtml live in src/lib/render.ts so the CLI can
 * import them without dragging in Elysia/db/auth. */

interface PageOpts {
  nav?: string;
  searchQuery?: string;
  loggedIn?: boolean;
  balance?: number | null;
  hideSearch?: boolean;
}

function htmlPage(title: string, body: string, opts: PageOpts = {}): string {
  const creditsUrl = `${LEGENDUM_BASE_URL}/account`;
  const balancePill =
    opts.balance != null
      ? `<span class="icon pill">&#x2C60; ${opts.balance.toLocaleString()}</span> `
      : `<span class="icon circle">&#x2C60;</span> `;
  // In self-hosted mode there is no login or billing — hide the pill entirely.
  const loginLink = isSelfHosted()
    ? ""
    : opts.loggedIn
      ? `<a href="${creditsUrl}" target="_blank" class="login">${balancePill}Buy Credits</a>`
      : `<a href="/login" class="login"><span class="icon circle">&#x2C60;</span> Log in with Legendum</a>`;
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
  <style>${PRISM_THEME_CSS}</style>
</head>
<body>
  <header>
    <nav>
      <span><a href="/">Wikis</a>${opts.nav || ""}</span>
      ${loginLink}
    </nav>
    ${
      opts.hideSearch
        ? ""
        : `<form class="search" method="get">
      <input type="text" name="q" placeholder="Search..." value="${escapeHtml(opts.searchQuery || "")}" aria-label="Search" autocomplete="off">
      <div class="search-results" hidden></div>
    </form>`
    }
  </header>
  <main>${body}</main>
  <footer><p>Powered by <a href="https://legendum.co.uk">Legendum</a></p></footer>
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
  (function(){
    var picker = document.querySelector('.js-page-select');
    if (!picker) return;
    picker.addEventListener('change', function(){
      var href = picker.value;
      if (href && href !== location.pathname) {
        location.assign(href);
      }
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
    const publicWikis = publicDb
      .prepare(
        "SELECT name, description FROM wikis WHERE visibility = 'public' ORDER BY name",
      )
      .all() as { name: string; description: string }[];

    let userWikis: { name: string; description: string }[] = [];
    if (user) {
      const db = getUserDb(user.id);
      userWikis = db
        .prepare("SELECT name, description FROM wikis ORDER BY name")
        .all() as { name: string; description: string }[];
    }

    // Search user's wikis only (public wikis have per-wiki search)
    if (query.q && user) {
      const db = getUserDb(user.id);
      const hits = await searchAllWikis(db, query.q, { limit: 10 });
      const allResults = hits.map((r) => {
        const slug = r.path.replace(/\.md$/, "");
        const title = slug
          .replace(/-/g, " ")
          .replace(/\b\w/g, (c) => c.toUpperCase());
        return {
          wiki: r.wiki,
          path: r.path,
          slug,
          title,
          chunk: r.chunk,
        };
      });

      const html = allResults
        .map(
          (r) =>
            `<li><a href="/${r.wiki}/${r.slug}"><strong>${r.wiki} / ${r.title}</strong> — ${escapeHtml(snippet(r.chunk))}</a></li>`,
        )
        .join("\n");
      return new Response(
        htmlPage(
          "Search",
          `<h1>Search: ${escapeHtml(query.q)}</h1><ul>${html || "<li>No results</li>"}</ul>`,
          { searchQuery: query.q, loggedIn: !!user, balance },
        ),
        { headers: { "Content-Type": "text/html" } },
      );
    }

    function wikiList(wikis: { name: string; description: string }[]) {
      return wikis
        .map((w) => {
          const desc = w.description ? ` — ${escapeHtml(w.description)}` : "";
          return `<li><a href="/${w.name}">${w.name}</a>${desc}</li>`;
        })
        .join("\n");
    }

    let body = `<h1><img src="/public/wikis.png" alt="" class="page-logo">Your Wikis</h1>`;

    if (user) {
      const list = wikiList(userWikis);
      body += `<ul>${list || "<li>No wikis yet. Install with <code>curl -fsSL https://wikis.fyi/public/install.sh | sh</code> then run <code>wikis init</code> in a project.</li>"}</ul>`;
    } else {
      // Hosted mode only — in self-hosted mode `user` is always set.
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
      { headers: { "Content-Type": "text/html" } },
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
    wiki = db.prepare("SELECT id FROM wikis WHERE name = ?").get(project) as {
      id: number;
    } | null;
  }

  if (!wiki) {
    const publicDb = getPublicDb();
    wiki = publicDb
      .prepare("SELECT id FROM wikis WHERE name = ? AND visibility = 'public'")
      .get(project) as { id: number } | null;
    if (wiki) {
      db = publicDb;
    }
  }

  if (!wiki) {
    set.status = 404;
    return new Response(
      htmlPage("Not Found", notFoundBody("This wiki doesn't exist."), {
        loggedIn,
        balance,
      }),
      { headers: { "Content-Type": "text/html" } },
    );
  }

  // Handle search
  if (query.q) {
    const results = await search(db, wiki.id, query.q, { limit: 20 });
    if (wantMarkdown) {
      const md = results
        .map(
          (r) =>
            `- [${r.path}](/${project}/${r.path}): ${r.chunk.slice(0, 100)}...`,
        )
        .join("\n");
      return new Response(`# Search: ${query.q}\n\n${md || "No results."}`, {
        headers: { "Content-Type": CONTENT_TYPE_MARKDOWN_UTF8 },
      });
    }
    const html = results
      .map((r) => {
        const slug = r.path.replace(/\.md$/, "");
        const title = slug
          .replace(/-/g, " ")
          .replace(/\b\w/g, (c) => c.toUpperCase());
        return `<li><a href="/${project}/${slug}"><strong>${title}</strong> — ${escapeHtml(snippet(r.chunk))}</a></li>`;
      })
      .join("\n");
    const navSearch = ` / <a href="/${project}">${project}</a> / <strong>Search</strong>`;
    return new Response(
      htmlPage(
        `Search: ${query.q}`,
        `<h1>Search: ${escapeHtml(query.q)}</h1><ul>${html || "<li>No results</li>"}</ul>`,
        { nav: navSearch, searchQuery: query.q, loggedIn, balance },
      ),
      { headers: { "Content-Type": "text/html" } },
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
  if (!file?.content) {
    set.status = 404;
    if (wantMarkdown) {
      return new Response("# Not Found\n", {
        headers: { "Content-Type": CONTENT_TYPE_MARKDOWN_UTF8 },
      });
    }
    return new Response(
      htmlPage("Not Found", notFoundBody("This page doesn't exist yet."), {
        loggedIn,
        balance,
      }),
      { headers: { "Content-Type": "text/html" } },
    );
  }

  if (wantMarkdown) {
    return new Response(file.content, {
      headers: { "Content-Type": CONTENT_TYPE_MARKDOWN_UTF8 },
    });
  }

  // Render HTML
  const pageSlug = file.path.replace(".md", "");
  const pageTitle = titleFromSlug(pageSlug);
  const isIndex = file.path === "index.md";
  const pages = listFiles(db, wiki.id)
    .filter((f) => f.path.endsWith(".md"))
    .map((f) => {
      const slug = f.path.replace(/\.md$/, "");
      return {
        slug,
        title: slug === "index" ? "Index" : titleFromSlug(slug),
        href: slug === "index" ? `/${project}` : `/${project}/${slug}`,
      };
    })
    .sort((a, b) => {
      if (a.slug === "index" && b.slug !== "index") return -1;
      if (b.slug === "index" && a.slug !== "index") return 1;
      if (a.slug === "log" && b.slug !== "log") return 1;
      if (b.slug === "log" && a.slug !== "log") return -1;
      return a.title.localeCompare(b.title);
    });
  const currentHref = isIndex ? `/${project}` : `/${project}/${pageSlug}`;
  const options = pages
    .map(
      (p) =>
        `<option value="${escapeHtml(p.href)}"${p.href === currentHref ? " selected" : ""}>${escapeHtml(p.title)}</option>`,
    )
    .join("");
  const pickerId = `page-picker-${project.replace(/[^a-zA-Z0-9_-]/g, "") || "wiki"}`;
  const nav = ` / <a href="/${project}">${escapeHtml(project)}</a> / <span class="page-picker"><label class="sr-only" for="${pickerId}">Choose page</label><select id="${pickerId}" class="js-page-select" aria-label="Choose page">${options}</select></span>`;
  const title = isIndex ? project : `${project} / ${pageTitle}`;
  const body = highlightCodeBlocks(renderMarkdown(file.content, project));
  const updates = getPageUpdates(db, wiki.id, filePath);
  const updatesHtml =
    updates.length > 0
      ? `<details class="page-updates"><summary>Recent changes</summary><ul>${updates.map((u) => `<li><time>${u.created_at}</time> ${escapeHtml(u.summary)}</li>`).join("")}</ul></details>`
      : "";
  return new Response(
    htmlPage(title, body + updatesHtml, { nav, loggedIn, balance }),
    { headers: { "Content-Type": "text/html" } },
  );
}

function titleFromSlug(slug: string): string {
  return slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Truncate plain text for search result snippets. */
function snippet(text: string, max = 150): string {
  const clean = text.replace(/\n/g, " ").replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const cut = clean.lastIndexOf(" ", max);
  return `${clean.slice(0, cut > 0 ? cut : max)}…`;
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
function resolveUser(
  headers: Record<string, string | undefined>,
): { id: number } | null {
  // Self-hosted mode: every visitor is the single local user.
  if (isSelfHosted()) {
    ensureLocalUser();
    return { id: LOCAL_USER_ID };
  }

  const cookie = headers.cookie;
  // Check API Bearer token first (CLI)
  const bearerToken = extractBearerToken(headers.authorization);
  if (bearerToken) return validateBearerToken(bearerToken);

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

function notFoundBody(message: string): string {
  return `<div class="not-found">
  <h1>404</h1>
  <p>${message}</p>
  <a href="/">Back to Wikis</a>
</div>`;
}
