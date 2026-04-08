/**
 * wikis open — serve the local wiki/ folder as HTML and open a browser.
 *
 * Reads .md files straight off disk in the current project's `wiki/` folder,
 * renders them with the same markdown→HTML pipeline used by wikis.fyi, and
 * serves at http://localhost:3456. No db, no auth, no sync — just a tiny
 * static-feeling preview server for editing wiki pages locally.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { highlightCodeBlocks, PRISM_THEME_CSS } from "../../src/lib/highlight";
import { renderMarkdown } from "../../src/lib/render";

const PORT = 3456;

function htmlShell(title: string, body: string, isIndex = false): string {
  // On the index page we still render the nav, but hidden — so the first
  // heading lines up at exactly the same vertical position as on subpages.
  const nav = `<nav class="top"${isIndex ? ' style="visibility:hidden"' : ""}><a href="/">← index</a></nav>`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
           max-width: 800px; margin: 2em auto; padding: 0 1em; line-height: 1.6;
           color: #222; }
    h1, h2, h3, h4 { line-height: 1.25; }
    h1 img.page-logo { display: none; }
    a { color: #0066cc; }
    code { background: #f4f4f4; padding: 0.1em 0.3em; border-radius: 3px;
           font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 0.9em; }
    pre { border-radius: 6px; overflow-x: auto; }
    pre code { background: none; padding: 0; }
    ${PRISM_THEME_CSS}
    blockquote { border-left: 4px solid #ddd; margin: 1em 0; padding: 0.2em 1em;
                 color: #555; }
    table { border-collapse: collapse; width: 100%; margin: 1em 0; }
    th, td { border: 1px solid #ddd; padding: 0.5em; text-align: left; }
    th { background: #f8f8f8; }
    nav.top { margin-bottom: 2em; font-size: 0.9em; color: #888; }
    nav.top a { color: #0066cc; text-decoration: none; }
  </style>
</head>
<body>
  ${nav}
  <main>${body}</main>
</body>
</html>`;
}

function notFound(slug: string): Response {
  return new Response(
    htmlShell(
      "Not found",
      `<h1>Not found</h1><p>No <code>${slug}.md</code> in this wiki folder.</p>`,
    ),
    { status: 404, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

export default async function open(args: string[]) {
  const cwd = process.cwd();
  // Resolve the wiki folder:
  //   1. explicit arg → use it
  //   2. ./<arg-or-"wiki"> exists → use it
  //   3. otherwise assume we're already inside a wiki folder → use cwd
  const argDir = args[0];
  let wikiDir: string;
  if (argDir) {
    wikiDir = resolve(cwd, argDir);
  } else if (existsSync(resolve(cwd, "wiki"))) {
    wikiDir = resolve(cwd, "wiki");
  } else {
    wikiDir = cwd;
  }
  if (!existsSync(wikiDir)) {
    console.error(
      `No ${basename(wikiDir)}/ folder found. Run \`wikis init\` first.`,
    );
    process.exit(1);
  }

  Bun.serve({
    port: PORT,
    fetch(req) {
      const url = new URL(req.url);
      // Map "/" → index, strip leading slash and trailing .md.
      const raw = url.pathname.slice(1).replace(/\.md$/, "") || "index";
      // Refuse anything with path separators or parent refs — single-level only.
      if (raw.includes("/") || raw.includes("..")) return notFound(raw);

      const filePath = resolve(wikiDir, `${raw}.md`);
      // Defensive: make sure the resolved path is still inside wikiDir.
      if (!filePath.startsWith(`${wikiDir}/`) || !existsSync(filePath)) {
        return notFound(raw);
      }

      const md = readFileSync(filePath, "utf8");
      const body = highlightCodeBlocks(renderMarkdown(md, ""));
      const title = raw.replace(/-/g, " ");
      return new Response(htmlShell(title, body, raw === "index"), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    },
  });

  const url = `http://localhost:${PORT}`;
  console.log(`Wiki preview: ${url}`);
  console.log("Press Ctrl+C to stop.");

  // Auto-open in the default browser. macOS=open, Linux=xdg-open, Windows=start.
  const opener =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "start"
        : "xdg-open";
  try {
    Bun.spawn([opener, url], { stdout: "ignore", stderr: "ignore" });
  } catch {
    // Non-fatal — user can click the URL above.
  }
}
