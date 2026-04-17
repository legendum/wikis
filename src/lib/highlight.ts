/**
 * Server-side syntax highlighting for code blocks emitted by `renderMarkdown`.
 *
 * Both the local `wikis open` preview server and the wikis.fyi web routes
 * use this so neither needs to fetch Prism from a CDN at runtime — the
 * preview works on a plane, and wikis.fyi has one fewer external dep.
 */
import Prism from "prismjs";
import "prismjs/components/prism-typescript";
import "prismjs/components/prism-bash";
import "prismjs/components/prism-json";
import "prismjs/components/prism-yaml";
import "prismjs/components/prism-sql";
import "prismjs/components/prism-python";
import "prismjs/components/prism-markdown";

/**
 * Inlined `prism-tomorrow` theme — verbatim from
 * `node_modules/prismjs/themes/prism-tomorrow.min.css`. Drop into a `<style>`
 * block in your HTML shell.
 */
export const PRISM_THEME_CSS = `code[class*=language-],pre[class*=language-]{color:#ccc;background:0 0;font-family:Consolas,Monaco,'Andale Mono','Ubuntu Mono',monospace;font-size:1em;text-align:left;white-space:pre;word-spacing:normal;word-break:normal;word-wrap:normal;line-height:1.5;-moz-tab-size:4;-o-tab-size:4;tab-size:4;-webkit-hyphens:none;-moz-hyphens:none;-ms-hyphens:none;hyphens:none}pre[class*=language-]{padding:1em;margin:.5em 0;overflow:auto}:not(pre)>code[class*=language-],pre[class*=language-]{background:#2d2d2d}:not(pre)>code[class*=language-]{padding:.1em;border-radius:.3em;white-space:normal}.token.block-comment,.token.cdata,.token.comment,.token.doctype,.token.prolog{color:#999}.token.punctuation{color:#ccc}.token.attr-name,.token.deleted,.token.namespace,.token.tag{color:#e2777a}.token.function-name{color:#6196cc}.token.boolean,.token.function,.token.number{color:#f08d49}.token.class-name,.token.constant,.token.property,.token.symbol{color:#f8c555}.token.atrule,.token.builtin,.token.important,.token.keyword,.token.selector{color:#cc99cd}.token.attr-value,.token.char,.token.regex,.token.string,.token.variable{color:#7ec699}.token.entity,.token.operator,.token.url{color:#67cdcc}.token.bold,.token.important{font-weight:700}.token.italic{font-style:italic}.token.entity{cursor:help}.token.inserted{color:green}`;

/**
 * Map common language aliases used in markdown fences to the names Prism
 * registered them under. Extend as new languages are imported above.
 */
const LANG_ALIASES: Record<string, string> = {
  ts: "typescript",
  js: "javascript",
  sh: "bash",
  shell: "bash",
  yml: "yaml",
  py: "python",
  md: "markdown",
};

/** Reverse the entity escaping that `renderMarkdown` applies inside `<code>`. */
function unescapeHtml(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
}

/**
 * Walk rendered HTML, find each `<pre class="language-…"><code class="language-…">…`
 * block emitted by `renderMarkdown`, and rewrite it with Prism-highlighted
 * spans. Unknown languages are left untouched (same markup, Prism theme still
 * styles `pre.language-*` for a dark block).
 */
export function highlightCodeBlocks(html: string): string {
  return html.replace(
    /<pre(?:\s+class="language-[^"]+")?\s*><code class="language-([\w-]+)">([\s\S]*?)<\/code><\/pre>/g,
    (match, rawLang: string, code: string) => {
      const lang = LANG_ALIASES[rawLang] || rawLang;
      const grammar = Prism.languages[lang];
      if (!grammar) return match;
      const highlighted = Prism.highlight(unescapeHtml(code), grammar, lang);
      return `<pre class="language-${lang}"><code class="language-${lang}">${highlighted}</code></pre>`;
    },
  );
}
