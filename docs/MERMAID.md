# Mermaid diagrams (client-side, no CDN)

This document specifies how wiki markdown should support **Mermaid** diagrams in the browser **without loading Mermaid or fonts from a CDN**. Implementation can follow this spec in stages; the doc is the source of truth for behavior and constraints.

## Goals

- Authors use normal fenced blocks with the `mermaid` info string:

  ````markdown
  ```mermaid
  flowchart LR
    A --> B
  ```
  ````

- Diagrams render in **HTML wiki pages** (wikis.fyi web UI and the local `wikis open` preview), not in raw `.md` responses.
- All executable assets are **served from the same origin** as the wiki (e.g. under `/public/`), built from the **`mermaid` npm package** — no `unpkg`, `jsdelivr`, or other third-party script hosts.

## Non-goals

- Server-side rendering of diagrams to SVG/PNG (possible later; out of scope here).
- Prism syntax highlighting of Mermaid source as a substitute for real diagrams.

## Current pipeline (context)

Today, fenced blocks become `<pre><code class="language-…">…</code></pre>`, then `highlightCodeBlocks` applies Prism where a grammar exists. Mermaid is not a Prism grammar; `language-mermaid` blocks stay as plain escaped code. A proper integration **must** treat `mermaid` as a **special case** before or instead of the generic code path.

## HTML shape

### Problem: escaping diagram text

Diagram source must reach the client as **exact UTF-8 text** (newlines, quotes, Unicode). Standard HTML text escaping turns `<` into `&lt;`, which **breaks** Mermaid if those characters appear in labels. Putting raw diagram text inside a normal element’s text node is therefore fragile unless the implementation guarantees safe embedding.

**Recommended approach:** emit a **non-executing** carrier for the raw source, then a tiny bootstrap that copies text into the element Mermaid expects.

1. For each `mermaid` fence, emit a wrapper (e.g. `<figure class="wiki-mermaid">` or a plain `div`) containing:
   - An empty or placeholder node that Mermaid will render into (conventionally `<div class="mermaid"></div>` per Mermaid docs), **or** a single container passed to `mermaid.run({ nodes: … })`.
   - Immediately after it, a `<script type="text/plain">` block whose **text content** is the raw diagram source. Browsers do not execute this script; it acts as a string carrier. The only characters that need attention in that carrier are sequences that could close the tag (e.g. `</script>` inside the diagram); the implementation must split or escape that edge case.

2. An **init script** (see below) runs after DOM ready: for each wiki-mermaid figure, read `textContent` from the `text/plain` script, assign it to the diagram container (e.g. `div.mermaid.textContent = …`), remove or hide the carrier, then invoke Mermaid.

This avoids base64 in attributes for typical pages while keeping semantics clear. Alternatives (base64 in `data-*`, or a JSON blob) are acceptable if documented and tested for large diagrams.

### Prism interaction

**Do not** run Prism on Mermaid blocks. Either:

- Emit **no** `<pre><code class="language-mermaid">` for these fences (preferred — special-case in `extractFencedCodeBlocks` / restore phase), or
- Strip Mermaid blocks in `highlightCodeBlocks` if they ever appear as code blocks.

## Bundling and serving (no CDN)

### Dependency

- Add **`mermaid`** as a normal npm dependency (pin a specific version in `package.json` / lockfile).

### Build output

- Produce one or more **browser bundles** from project source (e.g. an entry file that `import`s `mermaid` and calls `mermaid.initialize({ startOnLoad: false, … })` then runs the bootstrap above).
- Use **`bun build`** (or another bundler already in the repo if added later) with `--target=browser`, output into **`public/`** (e.g. `public/mermaid-client.js`) so Elysia/static routes serve it at `/public/mermaid-client.js` alongside `style.css`.

### Versioning and reproducibility

- The built file is **committed** or produced in CI before deploy — pick one policy and stick to it. The spec’s requirement is: **runtime never downloads Mermaid from the network**; the file is always same-origin.

### Fonts and themes

- Mermaid may pull fonts or default styling; configure Mermaid’s `theme` / `fontFamily` in the bundled init so behavior is predictable. Avoid loading fonts from Google Fonts or other CDNs if the product goal is “no CDN” broadly — prefer system font stacks or fonts already shipped under `/public/` if custom typography is required.

## Where to wire scripts

| Surface | Shell | Action |
|--------|--------|--------|
| Hosted / `wikis serve` | `htmlPage` in `src/routes/web.ts` | Add `<script type="module" src="/public/mermaid-client.js">` (or a classic bundle + inline boot if module-less), after `<main>` content or at end of `<body>`. |
| Local preview | `htmlShell` in `cli/commands/open.ts` | Same script tag so `wikis open` matches production rendering. |

Use **one** shared bootstrap pattern so local and hosted pages behave identically.

## Initialization contract

The bundled script should:

1. Wait for DOM ready (or use `defer` / `type="module"` natural ordering).
2. Find all wiki-mermaid roots (e.g. `document.querySelectorAll('.wiki-mermaid')` or the chosen selector).
3. Move diagram text from `type="text/plain"` scripts into the render target; handle the `</script>` edge case in the carrier.
4. Call `mermaid.run({ … })` **once** per page load (or per container, per Mermaid API guidance for the chosen major version).
5. Fail gracefully: if Mermaid throws, leave a visible fallback (e.g. `<pre>` with source or a short error in the figure) so the rest of the page still works.

Document the supported **Mermaid major version** in this file or in `package.json` when implemented.

## Security notes

- Diagrams run as script-driven rendering in the page; treat content as **author-controlled** (same trust model as the wiki markdown). Do not `innerHTML` diagram source.
- If a Content-Security Policy is added later, allow **same-origin** scripts for `/public/mermaid-client.js` and disallow `unsafe-eval` unless Mermaid’s version strictly requires it (prefer a configuration that does not).

## Testing checklist (when implemented)

- [ ] ` ```mermaid ` block renders on wikis.fyi-style page and in `wikis open`.
- [ ] Non-mermaid code blocks still Prism-highlight as today.
- [ ] Page with multiple diagrams; page with zero diagrams (script should not error).
- [ ] Diagram containing Unicode and long lines.
- [ ] Diagram or label containing a `</script>` substring (carrier edge case).
- [ ] No network requests to third-party hosts for Mermaid (verify in DevTools Network tab).

## References

- [Mermaid.js documentation](https://mermaid.js.org/) — API (`mermaid.initialize`, `mermaid.run`) and supported diagram types.
