# AI Generation

## Overview

AI Generation in the "wikis" project uses large language models (LLMs) via the agent in `src/lib/agent.ts`. The `runAgent` function orchestrates phases: optional section planning (skipped if pages exist unless `force=true`), pre-consolidation via `consolidatePages`, per-section generation/regeneration (skipping existing unless `force`), regeneration of pages with changed sources (via `source_files.wiki_paths` and `modified_at` comparison), recursive `fillMissingPages`, post-consolidation, and updates to special pages (`index.md`, `log.md`, wiki `description`) if changes occurred.

```typescript
export async function runAgent(
  db: Database,
  wikiId: number,
  config: WikiConfig,
  opts: { reason?: string; force?: boolean } = {},
): Promise<AgentResult> {
  // ... plan sections, consolidate, process sections, regenerate changed, fill missing, etc.
}
```

LLMs interact through `src/lib/ai.ts` (providers: xAI/Grok via `XAI_API_KEY`, OpenAI via `OPENAI_API_KEY`; detects first available). Self-hosted mode skips Legendum billing if user provides keys (`userHasOwnKey=true`).

Triggers: source uploads to `/api/sources` store files in `source_files` (if hash changed), schedule via `src/lib/regenerator.ts` (debounce 15min for existing wikis, immediate for new). Manual via `/api/rebuild`. Page deletion marks `wiki_files.deleted=TRUE`, cleans `wiki_chunks`, triggers agent (reason: `deleted page`).

[Public wikis](index.md) (`src/lib/public-wikis.ts`) clone repos, index sources, run agent.

## Regeneration Scheduling

`src/lib/regenerator.ts` uses per-wiki timers (`dbPath:wikiId`):

- Debounced (15min) for changes on existing wikis.
- Immediate (`setTimeout(0)`) for empty wikis; `inFlight` Set skips duplicates.

```typescript
export function scheduleRegeneration(
  dbPath: string,
  db: Database,
  wikiId: number,
  config: WikiConfig,
  opts?: { debounce?: boolean; reason?: string },
): boolean {
  const key = `${dbPath}:${wikiId}`;
  const debounce = opts?.debounce ?? true;
  const delay = debounce ? DEBOUNCE_MS : 0;
  // ... setTimeout with runAgent
}
```

## Agent Phases

### Section Planning

If no `config.sections` and no content pages (or `force`), LLM plans up to 24 via `planSections` using README + source tree.

### Per-Section Generation

For each section (`slugify(name).md`): LLM picks files (`pickFilesForSection`), prompts with sources + existing content + all pages list. Upserts via [database storage](database-storage.md), indexes chunks for [search features](search-features.md), sets `source_files.wiki_paths`.

### Changed Pages

`findChangedPages` finds pages where any `wiki_paths` source `modified_at > wiki_files.modified_at`.

### Consolidation

`consolidatePages` (up to 5 passes): LLM plans merges/removals from page previews, merges via specialized prompt (source-first, no redundancy, relative links), rewrites links, updates paths.

## fillMissingPages

Scans `.md` files (skip [index](index.md), [log](log.md)) for broken `[text](page.md)`:

```typescript
const linkRe = /\[([^\]]+)\]\(([^)]+\.md)\)/g;
const existingPaths = new Set(/* wiki_files paths */);
const missing = new Map<string, { linkText: string; contexts: string[] }>();
// Aggregate 5-line contexts per missing path
```

For each (recursive, max depth 3):

1. Pick sources via `pickFilesForSection` (using link text/context).
2. LLM prompt: contexts + all pages + sources.
3. Upsert, index, set paths, [log](log.md) summary via `summarizeChange`.

## Billing

Hosted mode: `billedChat` reserves via Legendum (`src/lib/agent/billing.ts`), settles on usage. Free quota applies. Self-hosted: direct LLM keys, no billing.