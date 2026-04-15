# AI Generation

## Overview

AI Generation in the "wikis" project employs large language models (LLMs) to generate and maintain wiki pages from ingested project source files. The agent in `src/lib/agent.ts` orchestrates the process via the `runAgent` function, which executes phases sequentially and accumulates an `AgentResult` tracking created/updated pages and token usage. Phases include optional section planning (if no sections provided in [configuration](configuration.md) and no content pages exist or `force=true`), pre-consolidation to merge redundant pages via `consolidatePages`, per-section generation or update (skipping existing unless `force`), incremental regeneration of changed pages (sources with `modified_at > wiki_files.modified_at` via comma-separated `wiki_paths`), recursive filling of missing interlinks via `fillMissingPages`, post-consolidation, and conditional regeneration of special pages (`index.md`, `log.md`, `wikis.description`) only if changes occurred. LLMs interact through a provider-agnostic interface in `src/lib/ai.ts`, supporting xAI (Grok) and OpenAI via dynamic handler imports and environment-configured API keys for [self-hosting](self-hosting.md). Provider detection prioritizes `XAI_API_KEY` then `OPENAI_API_KEY`. Billing integrates optionally via Legendum credits using `legendumToken`: it reserves upfront via `src/lib/billing.ts` (pricing from `config/pricing.yml`), settles based on actual usage (`input_tokens` + `output_tokens` with markup), and applies only in hosted mode without personal API keys (`isByLegendum() && !userHasOwnKey`).

Triggers activate on source uploads to `/api/sources`, which stores files in `source_files` only if SHA-256 hashes differ (`changed > 0`), detects initial builds (`files.length > 0 && wikiPageCount === 0`), and schedules regeneration via `src/lib/regenerator.ts`. Manual rebuilds occur via `/api/rebuild` with optional `force`. Regeneration debounces via per-wiki timers (15 minutes for existing wikis with pages, immediate via `setTimeout(0)` for new ones), keyed by `dbPath:wikiId`, using an `inFlight` Set to prevent duplicate immediates during initial builds. Page deletion via `/api/wikis/:name/pages/:path` marks `deleted = TRUE` in `wiki_files`, removes associated `wiki_chunks`, and asynchronously triggers `runAgent` (reason: `deleted page: ${pagePath}`) to rebuild `index.md` excluding the deleted page. [Public wikis](index.md) in `src/lib/public-wikis.ts` clone/pull repos (`git pull --ff-only`), glob sources (e.g., `src/**/*.ts`, `README.md`), ingest via `/api/sources` logic, and invoke `runAgent`.

## AI Providers and Chat Interface

LLM interactions abstract through `src/lib/ai.ts`, which resolves providers from environment variables (`XAI_API_KEY`, `OPENAI_API_KEY`) for vendor neutrality. The `chat` function selects the provider and model (defaults: "grok-4-1-fast-reasoning" for xAI, "gpt-5-mini" for OpenAI), dynamically importing handlers:

```typescript
export async function chat(options: ChatOptions): Promise<ChatResult> {
  const provider = resolveProvider(options.provider);
  const model = options.model || defaultModel(provider);
  const opts = { ...options, provider, model };

  switch (provider) {
    case 'xai': {
      const { chatGrok } = await import('./providers/grok');
      return chatGrok(opts);
    }
    case 'openai': {
      const { chatOpenAI } = await import('./providers/openai');
      return chatOpenAI(opts);
    }
    default:
      throw new Error(`Provider ${provider} not yet implemented — PRs welcome`);
  }
}
```

xAI uses an OpenAI-compatible SDK (`baseURL: "https://api.x.ai/v1"`). Shared logic in `providers/openai-compat.ts` handles messages and usage. The agent employs `billedChat` (from `./agent/billing`) for credit management: reserves if `config.legendumToken` exists and billing applies, then settles post-call via `src/lib/billing.ts` (credits from `pricing.yml`, markup applied, records `events` as `credits_used`).

## Regeneration Triggers

The `/api/sources` endpoint in `src/routes/api.ts` ingests files, updates `source_files` only on hash changes, computes `changed`, and schedules regeneration if `changed > 0 || needsInitialBuild`:

```typescript
const wikiPageCount = (db.prepare("SELECT COUNT(*) as c FROM wiki_files WHERE wiki_id = ?").get(wiki.id) as { c: number }).c;
const needsInitialBuild = files.length > 0 && wikiPageCount === 0;

const { scheduleRegeneration } = await import("../lib/regenerator");
const dbPath = `user${user.id}`;
const wikiConfig = { name: wikiName, legendumToken: user.legendum_token };

const wantsBuild = changed > 0 || needsInitialBuild;
const queuedRegeneration = wantsBuild
  ? scheduleRegeneration(dbPath, db, wiki.id, wikiConfig, {
      debounce: wikiPageCount > 0,
      reason: wikiPageCount === 0 ? 'initial wiki build' : 'source files changed',
    })
  : false;
```

The `/api/rebuild` endpoint queues `runAgent` asynchronously with `force`. `src/lib/regenerator.ts` manages timers:

```typescript
const DEBOUNCE_MS = 15 * 60 * 1000; // 15 minutes

export function scheduleRegeneration(
  dbPath: string, db: Database, wikiId: number, config: WikiConfig,
  opts?: { debounce?: boolean; reason?: string }
): boolean {
  const key = `${dbPath}:${wikiId}`;
  // Clears/resets timer (debounce=true) or queues immediate (!debounce, skips if inFlight)
}
```

Timers use `setTimeout`/`clearTimeout`; `inFlight` blocks concurrent immediates for new wikis.

## The Wiki Agent

`runAgent` in `src/lib/agent.ts` executes phases, logging to `wiki_updates`:

1. **Section Planning**: If no `sections` in [configuration](configuration.md) and (no content pages or `force=true`), LLM proposes sections from source tree, README preview (2048 chars), existing pages; parses JSON or defaults to predefined sections.

2. **Pre-consolidation**: LLM merges redundant existing pages via `consolidatePages`.

3. **Per-Section Generation**: LLM selects files from tree (≤20 via `pickFilesForSection`), fetches contents, prompts with wiki style rules, generates via `billedChat`, extracts via `extractMarkdown`, upserts `wiki_files`, indexes `wiki_chunks`, links via `source_files.wiki_paths`, records change summary. Skips existing unless `force`.

   Prompts enforce wiki style (third person, headings, existing links only):

   ```typescript
   const messages = buildMessages(
     config,
     section,
     sourceContext,
     existing?.content || null,
     allPages,
   );
   ```

4. **Incremental Updates**: `findChangedPages` identifies pages where any `source_files.modified_at > wiki_files.modified_at` via `wiki_paths`; regenerates using ≤20 sources.

5. **Fill Missing Links**: Recursively scans for absent `[text](page.md)` (excl. specials), collects contexts, LLM generates (depth ≤3).

6. **Post-consolidation**: LLM merges overlaps via `consolidatePages`.

7. **Special Pages** (if changes): LLM updates `index.md` (README intro + pages list), appends `log.md` (changes, tokens), sets `wikis.description` (README sentence).

Tracks `AgentResult`; summarizes in `wiki_updates`.

## Search and Embeddings

Post-generation, `src/lib/indexer.ts` chunks content (512 chars, 64 overlap via `src/lib/chunking.ts`), stores in `wiki_chunks` (FTS5 autoindexed via triggers), embeds asynchronously via Ollama (`all-minilm` at `localhost:11434`) in `src/lib/rag.ts`. `src/lib/search.ts` performs hybrid search: FTS5 retrieves 50 candidates (escaped/phrase-quoted), re-ranks by cosine similarity (vector primary, FTS *0.5 fallback):

```typescript
export async function search(db: Database, wikiId: number, query: string, opts: { limit?: number } = {}): Promise<SearchResult[]> {
  // FTS → embed query → cosine on candidates → hybrid score (vector primary, FTS fallback *0.5)
}
```

FTS-only if Ollama unavailable. `/api/search/:wiki` exposes hybrid results.

## Advanced Features

- **Incremental Detection**: Timestamps + `wiki_paths` track changes.
- **Missing Links**: Recursive ≤3 depth; contexts + link text drive generation.
- **Consolidation**: LLM merges pre/post.
- **Special Pages**: Conditional LLM-driven; static `index.md` fallback.
- **Public Wikis**: Automated clone/pull/glob/ingest/agent.
- **Page Deletion**: `deleted=TRUE`, chunks removed, `index.md` rebuild.
- **Wiki Sync**: `/api/sync` diffs manifests, `/push` upserts/indexes wiki files, `/pull` retrieves.
- **Markdown Extraction**: `extractMarkdown` strips outer fences.

## Design Decisions

Provider modularity enables swaps ([configuration](configuration.md)). Debouncing optimizes costs ([syncing-mechanism.md](syncing-mechanism.md)). Hybrid FTS+vector (50 candidates) enhances [search-features](search-features.md). Billing reserves/settles per `pricing.yml`, skips self-hosted/own keys. Fallbacks (all files/static/FTS-only) ensure robustness. Source trees enable lightweight planning. WAL/FTS5 triggers maintain consistency ([database-storage.md](database-storage.md)).