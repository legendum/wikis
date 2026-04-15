# Page

Wiki pages are LLM-generated markdown files stored in the `wiki_files` table as `slug.md` entries. They form the core documentation units of a wiki. The LLM agent creates pages from planned sections or missing links, incrementally updates them on source changes, fills gaps by scanning for broken references, consolidates redundancies, and maintains special pages like [index.md](index.md) and [log.md](log.md).

Pages follow strict generation rules to ensure consistency: third-person present tense, thorough explanations of concepts and design decisions, structured with headings (##, ###), code examples from sources (always closing fences), relative links only to existing pages (e.g., [Page Name](page-name.md)), and no meta-commentary.

## Naming Conventions

### Slugs

Slugs are URL-friendly filenames derived from page titles using `slugify`. They form paths like `architecture.md`.

```typescript
// src/lib/agent/helpers.ts (imported in agent.ts)
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
```

Examples:
- `"Page Name"` → `page-name`
- `"AI Generation!"` → `ai-generation`

Special pages use fixed slugs: [index.md](index.md), [log.md](log.md).

### Display Names

Display names for links are title-cased slugs: `page-name` → `Page Name`. Arbitrary link text is allowed in `[Text](slug.md)`.

## Link Rendering

The `renderMarkdown` function converts markdown to HTML, resolving wiki links relative to the project path (`/{wiki}/{slug}`) and supporting standard and bare formats.

```typescript
// src/lib/render.ts (used in routes/web.ts)
.replace(/\[[^\]]+\]\(([^/)][^)]*?)\.md\)/g, (_, text, slug) => `<a href="${linkBase}/${slug}">${text}</a>`)
.replace(/\[([^\]]+?)\.md\](?!\()/g, (_, slug) => {
  const title = slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  return `<a href="${linkBase}/${slug}">${title}</a>`;
});
```

- Standard: `[Page Name](page.md)` → `<a href="/wiki/page">Page Name</a>`
- Bare: `[page.md]` → `<a href="/wiki/page">Page Name</a>`

External URLs (`https://`) pass through unchanged. Links target existing pages only; the agent enforces this during generation and consolidation.

## Lifecycle

The LLM agent in `runAgent` ([architecture.md](architecture.md)) orchestrates the lifecycle. Regeneration debounces 15 minutes after source changes via `scheduleRegeneration` to avoid excessive LLM calls during active editing.

```typescript
// src/lib/regenerator.ts
const DEBOUNCE_MS = 15 * 60 * 1000; // 15 minutes
```

### Creation

- **Planning**: LLM proposes sections from README and source tree (`planSections`).
- **File Selection**: `pickFilesForSection` selects ≤20 relevant sources per section.
- **Generation**: LLM prompted with sources, existing pages list (`buildMessages`), and rules. `extractMarkdown` strips non-markdown; `upsertFile` stores; `indexFile` chunks/indexes for search; `setWikiPaths` links sources to page.

Initial builds run immediately; subsequent debounced.

### Incremental Updates

`findChangedPages` identifies pages where any linked source `modified_at` exceeds the page `modified_at`:

```typescript
// src/lib/agent/helpers.ts (used in agent.ts)
export function findChangedPages(db: Database, wikiId: number): Set<string> {
  // Queries source_files.wiki_paths vs wiki_files.modified_at
}
```

Regenerates ≤20 sources per page, preserving context.

### Filling Missing Links

`fillMissingPages` scans content (depth ≤3) for `[text](missing.md)`, collects contexts/sources, generates via LLM.

```typescript
// src/lib/agent/pages.ts
const linkRe = /\[([^\]]+)\]\(([^)]+\.md)\)/g;
```

### Consolidation

`consolidatePages` runs ≤5 passes: LLM proposes `MergePlan` (merges/removals/redirects), merges content/sources, rewrites links across all pages, updates indexes/wiki_paths.

```typescript
// src/lib/consolidate.ts
{
  "merge": [{ "into": "target.md", "from": ["old.md"], "reason": "..." }],
  "remove": [{ "page": "dup.md", "redirect": "target.md", "reason": "..." }]
}
```

Design preserves information: merges use full sources + page previews; removals rewrite links.

## Storage and Indexing

Flat structure (`slug.md`, no `pages/` prefix); served as `/{wiki}/{slug}` or raw `/{wiki}/{slug}.md`.

- **wiki_files**: `path`, `content`, `hash` (SHA-256 prefix), `modified_at`, `deleted` (soft-delete to prevent regeneration).
- **source_files**: Full sources, `wiki_paths` (comma-separated pages).
- **wiki_chunks**: 512-char chunks (64 overlap) in `wiki_chunks` + FTS5 (`wiki_chunks_fts`) for keyword search; embeddings (Ollama) for RAG ([search-features.md](search-features.md)).
- **wiki_updates**: Per-page summaries (`recordUpdate`) for "Recent changes" UI.

```typescript
// src/lib/storage.ts
export function upsertFile(db: Database, wikiId: number, path: string, content: string, modified: string): void {
  const hash = hashContent(content); // SHA-256
  // INSERT OR UPDATE
}
```

Deletions (`deleted=true`) cascade chunks/updates; trigger `runAgent` for [index.md](index.md) rebuild.

Manifests (slug → `{hash, modified}`) enable [syncing-mechanism.md](syncing-mechanism.md).

### Indexing

`indexFile` chunks pages, upserts `wiki_chunks`, computes embeddings asynchronously (`storeEmbeddings`). Client `/push` skips embeddings (human edits).

```typescript
// src/lib/indexer.ts
const chunks = chunkText(path, content); // src/lib/chunking.ts
```

## Rendering and Rules

Server-rendered via Eta in `routes/web.ts`: `highlightCodeBlocks(renderMarkdown(content, wiki))` adds Prism highlighting (TypeScript, Bash, JSON, etc.).

- **HTML**: Full page with nav (page picker from `listFiles`), search (`?q=`), recent changes (`getPageUpdates`).
- **Markdown**: Raw via `.md` suffix.

Page picker sorts: [index.md](index.md) first, [log.md](log.md) last.

LLM prompts enforce rules; agent updates [index.md](index.md) (catalog), appends [log.md](log.md).