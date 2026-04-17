# Pages

Wiki pages are LLM-generated markdown files stored in the `wiki_files` table with flat paths like `architecture.md`. They form the core documentation units of a wiki. The LLM agent creates them from planned sections or missing links, regenerates on source changes via `wiki_paths` mappings, fills gaps by resolving broken references up to depth 3, and maintains special pages like [index.md](index.md) and [log.md](log.md).

Pages follow strict rules: third-person present tense, thorough explanations of concepts and design decisions, structured with headings (##, ###), code examples from sources (always closing fences), relative links only to existing pages like [Architecture](architecture.md), and no meta-commentary.

## Naming Conventions

### Slugs

Slugs are kebab-case identifiers without `.md`, forming flat filenames. The agent generates them via `slugify` from LLM-proposed section names or link text.

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

Special pages use fixed slugs: `index.md`, `log.md`.

```typescript
// src/lib/agent/types.ts
export const SPECIAL_PAGES = new Set(["index.md", "log.md"]);
```

### Display Names

Display names title-case slugs (removing `.md`) for UI, navigation, indexes, and bare links.

```typescript
// src/routes/web.ts + src/lib/render.ts (equivalent)
function titleFromSlug(slug: string): string {
  return slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
```

- `page-name` → `Page Name`
- `index` → `Index`

Used in page pickers (sorted: index first, log last), prompts, and bare link rendering.

### Special Pages

| Path     | Purpose                          | Maintenance                  |
|----------|----------------------------------|------------------------------|
| `index.md` | Catalog of all pages + intro    | `updateIndex` (`meta.ts`)   |
| `log.md`  | Append-only changelog            | `appendLog` (`meta.ts`)     |

## Generation Process

### Section Planning

On first build or updates, `planSections` asks the LLM to propose up to 24 sections based on README, directory tree, and existing pages (to avoid overlap).

```typescript
// src/lib/agent/sections.ts
const result = await chat({
  messages: [
    {
      role: "system",
      content: `...propose up to 24 wiki pages... Keep names short (1–3 words)...`,
    },
    {
      role: "user",
      content: `Propose wiki pages for the "${config.name}" project.\n\n${existingPages.length > 0 ? `Existing pages...\n${existingPages.join("\n")}\n\n` : ""}${readme ? `README:\n${readme.slice(0, PAGE_PREVIEW_LENGTH)}\n\n` : ""}Directory tree:\n${tree}`,
    },
  ],
});
```

Parses JSON `[{"name": "Architecture", "description": "..."}]`. Fallbacks to defaults like Overview, Architecture, Getting Started.

For each: `pickFilesForSection` selects relevant sources; LLM writes page via `buildMessages`; indexes chunks; sets `source_files.wiki_paths`.

See [ai-generation.md](ai-generation.md).

### Filling Missing Pages

`fillMissingPages` scans `.md` files for broken `[Text](ai-generation.md)` links, collects contexts (3 lines around), recurses (max depth 3).

```typescript
// src/lib/agent/pages.ts
const linkRe = /\[([^\]]+)\]\(([^)]+\.md)\)/g;
// ... skip existing/SPECIAL_PAGES
missing.get(href)?.contexts.push(/* surrounding lines */);
```

Uses link text as `name`, context as `description` for `pickFilesForSection`; generates via LLM; records update summary.

## Paths and Serving

Flat paths (`slug.md`), no `pages/` prefix. Served as `/{wiki}` (index.md) or `/{wiki}/{slug}` (HTML) / `{slug}.md` (raw).

```typescript
// src/routes/web.ts
if (slug === "" || slug === "index") {
  filePath = "index.md";
} else {
  filePath = `${slug}.md`;
}
```

`listFiles` builds navigation; `renderMarkdown` resolves links (`[Page Name](page.md)` → `href="/{wiki}/page-name"`).

Search via `?q=` uses [search-features.md](search-features.md).

## Storage and Updates

- `wiki_files`: `path`, `content`, `hash` (SHA-256), `modified_at`.
- `source_files`: full `content`, `wiki_paths` (e.g., "architecture.md,index.md").
- `wiki_chunks`: 512-char chunks (64 overlap) + FTS5/embeddings.
- `wiki_updates`: LLM summaries ("Created: ...").

```typescript
// src/lib/storage.ts (upsertFile)
const hash = hashContent(content);
db.prepare(`
  INSERT INTO wiki_files ... ON CONFLICT ... DO UPDATE SET
    content = excluded.content, hash = excluded.hash, modified_at = excluded.modified_at
`).run(...);
```

`findChangedPages` regenerates if `source_files.modified_at > wiki_files.modified_at`. Human edits sync without agent trigger ([syncing-mechanism.md](syncing-mechanism.md)).

See [database-storage.md](database-storage.md).