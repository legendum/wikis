# Missing

The "wikis" project automatically detects and generates wiki pages linked from existing content but not yet created.

## Detection Process

`fillMissingPages` scans all `.md` wiki pages up to depth 3 for broken links matching `[text](page.md)` where `path.md` does not exist and is not a [special page](architecture.md#special-pages). It collects the link text and up to 5 lines of surrounding context from each referencing file.

```typescript
const linkRe = /\[([^\]]+)\]\(([^)]+\.md)\)/g;
// Matches links, skips existing or special paths
```

Contexts are aggregated per missing path, e.g.:

```
From page.md:
### Filling Missing Links

`fillMissingPages` scans content (depth ≤3) for `[text](missing.md)`, collects contexts/sources, generates via LLM.
```

## Generation

For each missing page:
- Derives page name from slug (e.g., `missing.md` → "Missing").
- Uses [file selection](ai-generation.md#file-selection) via `pickFilesForSection` to choose relevant source files.
- Prompts the LLM with contexts, allowed [wiki pages](index.md), and selected sources.

The system prompt enforces wiki style rules:

```typescript
{
  role: "system",
  content: `You are a wiki maintainer for the "${config.name}" project. You write clear, well-structured markdown wiki pages.
Rules:
- Write in third person, present tense
- Be concise but thorough
- Use headings (##, ###) to structure content
- Include code examples from sources when they clarify concepts — always close code fences
- ONLY link to pages in the "Wiki pages" list below
- Use relative markdown links like [Page Name](page.md)
- Do not include meta-commentary about the writing process
- Output ONLY the markdown content for the page`,
}
```

Generated content is extracted (strips outer fences), indexed into [wiki chunks](database-storage.md), and source paths are recorded. A [change summary](log.md) is added.

## Recursion and Limits

Newly created pages trigger re-scan up to `MAX_DEPTH = 3`. No further recursion beyond this to prevent infinite loops.

## Integration

Invoked by [agent](architecture.md) during regeneration after source changes or [page updates](page.md). Logs progress:

```
Found 1 missing pages to fill: missing.md
Filling missing page "missing.md" (3 source files, calling LLM...)
Filled missing page "missing.md" (250 tokens)
```

See [ai-generation.md](ai-generation.md) for LLM details, [search-features.md](search-features.md) for indexing.