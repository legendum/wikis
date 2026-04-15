# Page

Wiki pages are LLM-generated markdown files stored as `slug.md` in `wiki_files`. They form the core documentation units, created from planned sections or missing links, incrementally updated on source changes, and consolidated to eliminate redundancy.

## Naming Conventions

### Slugs

Slugs are URL-friendly filenames derived from page titles via `slugify`, used for paths like `architecture.md`.

```typescript
// src/lib/agent/helpers.ts
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

Special pages like [index.md](index.md) and [log.md](log.md) use fixed slugs.

### Display Names

Display names (link text) are title-cased slugs: `page-name` → `"Page Name"`. Arbitrary text is allowed in standard links.

## Link Rendering

`renderMarkdown` converts markdown links to HTML, prefixing with `/{wiki}/` and supporting formats:

- Standard: `[Page Name](page.md)` → `<a href="/wiki/page-name">Page Name</a>`
- Bare: `[page.md]` → `<a href="/wiki/page-name">Page Name</a>`

```typescript
// src/lib/render.ts
.replace(/\[[^\]]+\]\(([^/)][^)]*?)\.md\)/g, (_, text, slug) => `<a href="${linkBase}/${slug}">${text}</a>`)
.replace(/\[([^\]]+?)\.md\](?!\()/g, (_, slug) => {
  const title = slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  return `<a href="${linkBase}/${slug}">${title}</a>`;
});
```

Rules: Relative links only to existing pages; external URLs handled separately.

## Lifecycle

### Creation

- **Planning**: LLM proposes sections from README/tree ([ai-generation.md](ai-generation.md)).
- **File Selection**: `pickFilesForSection` chooses ≤20 relevant sources.
- **Generation**: LLM prompted with sources, existing pages list; `extractMarkdown` strips fences; `upsertFile`; `setWikiPaths` links sources/pages.

### Incremental Updates

`findChangedPages` detects pages where source `modified_at` > page `modified_at`:

```typescript
// src/lib/agent/helpers.ts
export function findChangedPages(db: Database, wikiId: number): Set<string> {
  // Queries source_files.wiki_paths vs wiki_files.modified_at
}
```

Regenerates ≤20 sources/page; logs changes.

### Filling Missing Links

`fillMissingPages` scans for `[text](page.md)` (depth ≤3), collects contexts, generates via LLM:

```typescript
// src/lib/agent/pages.ts
const linkRe = /\[([^\]]+)\]\(([^)]+\.md)\)/g;
// Collects missing[href], prompts with contexts/sources/allPages
```

### Consolidation

`consolidatePages` (≤5 passes) prompts LLM for `MergePlan` (merges/removals/redirects), combines sources/content, rewrites links:

```typescript
// src/lib/consolidate.ts
{
  "merge": [{ "into": "target.md", "from": ["old.md"], "reason": "..." }],
  "remove": [{ "page": "dup.md", "redirect": "target.md", "reason": "..." }]
}
```

## Storage and Indexing

- **wiki_files**: `path`, `content`, `hash` (SHA-256), `modified_at`, `deleted`.
- **source_files**: Full sources with `wiki_paths` (comma-separated pages).
- **wiki_chunks**: Chunks (512 chars, 64 overlap) for FTS5/RAG ([search-features.md](search-features.md)).
- **wiki_updates**: Summaries like "Updated: Added X".

Manifests key by slug for [syncing-mechanism.md](syncing-mechanism.md). Deletions cascade chunks/updates.

## Rendering and Rules

Server-rendered HTML via Eta: headings, lists/tables, code highlighting ([architecture.md](architecture.md)). LLM rules: third-person present, headings, source code, existing links only, no meta-commentary. Updates append [log.md](log.md); [index.md](index.md) catalogs pages.