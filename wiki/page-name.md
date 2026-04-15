# Page Name

Wiki pages derive their display names from file path slugs. The agent converts `slug.md` paths to human-readable titles for prompts, indexes, and UI rendering.

## Name Generation

Page names transform slugs by removing `.md`, replacing hyphens with spaces, and title-casing words.

```typescript
const pageName = pagePath
  .replace(/\.md$/, "")
  .replace(/-/g, " ")
  .replace(/\b\w/g, (c) => c.toUpperCase());
```

For `page-name.md`, this yields "Page Name". The [slugify](slugify-helpers.md) function generates slugs from section names during creation:

```typescript
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
```

Slugs form flat filenames like `architecture.md` without directories.

## Usage in Agent

During [ai-generation.md](ai-generation.md), the agent uses link text from references as the section `name` and context excerpts as `description` for file selection via [pickFilesForSection](sections.ts).

```typescript
const pick = await pickFilesForSection(
  db,
  wikiId,
  config,
  { name: info.linkText, description: info.contexts[0] || info.linkText },
  tree,
);
```

Fallbacks use top source paths if selection fails. Prompts include the derived page name:

```
Create the wiki page "${pageName}" (${pagePath}).
```

## Storage and Linking

Pages store as `wiki_files.path` like `page-name.md`. Links use `[Page Name](page-name.md)` format. The [fill missing pages](pages.ts) scans content for unmatched `.md` links:

```typescript
const linkRe = /\[([^\]]+)\]\(([^)]+\.md)\)/g;
```

It collects contexts (3 lines before/after) and recurses up to depth 3.

## Special Cases

Special pages like [index.md](index.md) and [log.md](log.md) skip standard naming. Consolidated or regenerated pages retain slugs but update content per [architecture.md](architecture.md). 

Page names ensure consistency across [search-features.md](search-features.md), [index.md](index.md), and navigation.