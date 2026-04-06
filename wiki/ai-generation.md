# AI Generation

## Overview

AI Generation in the "wikis" project employs large language models (LLMs) to generate and maintain wiki pages from ingested project source files. The agent in `src/lib/agent.ts` orchestrates the process: it performs pre-consolidation to merge redundant pages, plans sections if absent from [configuration](configuration.md), selects relevant source files via LLM analysis of the source tree string, generates or updates structured markdown pages for each section, handles incremental updates for changed sources using timestamps and `wiki_paths`, recursively fills missing interlinks up to depth 3, performs post-consolidation to merge overlaps, and regenerates special pages like `index.md` and `log.md`. LLMs interact through a provider-agnostic interface in `src/lib/ai.ts`, supporting xAI (Grok) and OpenAI via dynamic handler imports and environment-configured API keys for [self-hosting](self-hosting.md). Billing integrates optionally via Legendum credits using `legendumToken`: it reserves upfront (computed from `src/lib/billing.ts` pricing), settles based on actual usage, and applies only to hosted users lacking personal API keys (`shouldBill(IS_HOSTED && !userHasOwnKey)`).

Triggers activate on source uploads to `/api/sources`, which stores files in `source_files` only if SHA-256 hashes differ (`changed > 0`), detects initial builds (`files.length > 0 && wikiPageCount === 0`), and schedules regeneration via `src/lib/regenerator.ts`. Manual rebuilds occur via `/api/rebuild` with optional `force`. Regeneration debounces via per-wiki timers (15 minutes for existing wikis with pages, immediate for new ones via `setTimeout(0)`), keyed by `dbPath:wikiId`, using an `inFlight` Set to prevent duplicate immediates during initial builds. Page deletion via `/api/wikis/:name/pages/:path` marks `deleted = TRUE` in `wiki_files`, removes associated `wiki_chunks`, and asynchronously triggers `runAgent` to rebuild `index.md` excluding the deleted page.

## AI Providers and Chat Interface

LLM interactions abstract through `src/lib/ai.ts`, which resolves providers from environment variables (`XAI_API_KEY`, `OPENAI_API_KEY`) for vendor neutrality. The `chat` function selects the provider and model, dynamically importing handlers:

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

Defaults favor "grok-4-1-fast-reasoning" for xAI and "gpt-5-mini" for OpenAI. Provider priority follows available keys; xAI uses an OpenAI-compatible SDK (`baseURL: "https://api.x.ai/v1"`). Shared logic in `providers/openai-compat.ts` handles messages and usage. The agent employs `billedChat` for credit management: it reserves if `config.legendumToken` exists and `shouldBill(!!config.userHasOwnKey)`, then settles post-call via `src/lib/billing.ts` (credits from `pricing.yml`, markup applied).

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

Timers use `setTimeout`/`clearTimeout` for debouncing; `inFlight` blocks concurrent immediates for new wikis.

## The Wiki Agent

`runAgent` in `src/lib/agent.ts` executes phases sequentially, accumulating `AgentResult` (created/updated pages, usage) and logging to `wiki_updates`:

1. **Pre-consolidation**: LLM merges redundant existing pages via `consolidatePages`.

2. **Section Planning**: If no `sections` in [configuration](configuration.md) and (no content pages exist or `force=true`), LLM proposes ≤24 sections from source tree, README preview (2048 chars), and existing pages; parses JSON `[{name, description}]` or defaults to Overview/Architecture/Getting Started.

3. **Per-Section Generation**: LLM selects ≤20 paths from tree (JSON fallback: all sources), fetches contents, prompts with wiki style rules/system message, generates via `billedChat`, extracts via `extractMarkdown` (strips outer fences), upserts `wiki_files`, indexes `wiki_chunks`, links via `source_files.wiki_paths`, records change summary.

   Prompts enforce wiki style:

   ```typescript
   function buildMessages(
     config: WikiConfig, section: { name: string; description: string },
     sourceContext: string, existingContent: string | null, allPages: string
   ): ChatMessage[] {
     // System: rules (third person, headings, existing links only, etc.)
     // User: Update/Create with description, existing, allPages list, sources
   }
   ```

4. **Incremental Updates**: `findChangedPages` identifies pages where any `source_files.modified_at > wiki_files.modified_at` via comma-separated `wiki_paths`; regenerates using ≤20 sources per page.

5. **Fill Missing Links**: Recursively (depth ≤3) scans `\[([^\]]+)\]\(([^)]+\.md)\)` for absent pages (excluding `index.md`/`log.md`), collects contexts (±2/3 lines), LLM picks sources using link text, generates.

6. **Post-consolidation**: LLM detects/merges overlaps via `consolidatePages`.

7. **Special Pages**: LLM generates `index.md` (intro from README + exact pages list), appends `log.md` (changes, tokens), updates `wikis.description` (one-sentence from README); static fallback for `index.md`.

Tracks via `AgentResult`; summarizes in `wiki_updates`. [Public wikis](index.md) in `src/lib/public-wikis.ts` clone/pull repos (`git pull --ff-only`), glob sources (e.g., `src/**/*.ts`, `README.md`), ingest via `/api/sources` logic, and invoke agent.

## Search and Embeddings

Post-generation, `src/lib/indexer.ts` chunks content (512 chars, 64 overlap via `src/lib/chunking.ts`), stores in `wiki_chunks` (FTS5 autoindexed via triggers), embeds asynchronously via Ollama (`all-minilm` at `localhost:11434`) in `src/lib/rag.ts`. `src/lib/search.ts` performs hybrid search: FTS5 retrieves 50 candidates (escaped/phrase-quoted), re-ranks by cosine similarity on embeddings (vector primary, FTS *0.5 fallback):

```typescript
export async function search(db: Database, wikiId: number, query: string, opts: { limit?: number } = {}): Promise<SearchResult[]> {
  // FTS → embed query → cosine on candidates → hybrid score (vector primary, FTS fallback *0.5)
}
```

FTS-only fallback if Ollama unavailable. No source-file RAG; tree strings suffice for selection.

## Advanced Features

- **Incremental Detection**: Timestamps track `source_files.modified_at > wiki_files.modified_at` via comma-separated `wiki_paths`.
- **Missing Links**: Recursive ≤3 depth; contexts + link text drive LLM source selection/generation.
- **Consolidation**: LLM merges redundancies pre/post-generation.
- **Special Pages**: LLM-driven `index.md` (or static fallback), append-only `log.md` with stats [log.md](log.md).
- **Public Wikis**: Automated clone/pull/glob/ingest/agent.
- **Page Deletion**: `deleted=TRUE`, chunk removal, `index.md` rebuild trigger.
- **Markdown Extraction**: `extractMarkdown` strips outer fences.

## Design Decisions

Provider modularity in `ai.ts` enables swaps without agent changes ([configuration](configuration.md)). Debouncing optimizes costs during [syncing-mechanism](syncing-mechanism.md). Hybrid FTS+vector (50 candidates, chunk-aligned) enhances [search-features](search-features.md). Billing reserves per model pricing (`pricing.yml`), settles actuals, skips for self-hosted/own keys. Fallbacks (JSON parse → all files/static index/FTS-only) ensure robustness. Source tree strings enable lightweight LLM planning. WAL journals and FTS5 triggers (`wiki_chunks_ai/ad/au`) maintain consistency ([database-storage.md](database-storage.md)).