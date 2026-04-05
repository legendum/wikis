/**
 * Post-build consolidation pass.
 *
 * After the agent generates all wiki pages, this module reviews the full
 * page list and asks the LLM to identify redundant/overlapping pages.
 * It then merges or removes pages and rewrites all cross-references.
 */
import { Database } from "bun:sqlite";
import type { ChatMessage } from "./ai";
import { upsertFile, getFile, listFiles, deleteFile, recordUpdate } from "./storage";
import { indexFile, removeFile } from "./indexer";
import { log } from "./log";
import { PAGE_PREVIEW_LENGTH } from "./constants";

export interface ConsolidateConfig {
  name: string;
}

export interface ConsolidateResult {
  pagesUpdated: string[];
  usage: { input_tokens: number; output_tokens: number };
}

/** A chat function that handles billing. Passed in to avoid circular imports. */
export type ChatFn = (options: {
  messages: ChatMessage[];
  description?: string;
}) => Promise<{ content: string; usage: { input_tokens: number; output_tokens: number } }>;

interface MergePlan {
  merge: { into: string; from: string[]; reason: string }[];
  remove: { page: string; redirect: string; reason: string }[];
}

const SPECIAL = new Set(["index.md", "log.md"]);

/**
 * Ask the LLM to review all wiki pages and identify consolidation opportunities.
 */
async function planConsolidation(
  db: Database,
  wikiId: number,
  config: ConsolidateConfig,
  chatFn: ChatFn,
): Promise<{ plan: MergePlan; usage: { input_tokens: number; output_tokens: number } }> {
  const files = listFiles(db, wikiId).filter(
    (f) => f.path.endsWith(".md") && !SPECIAL.has(f.path),
  );

  if (files.length < 2) {
    return { plan: { merge: [], remove: [] }, usage: { input_tokens: 0, output_tokens: 0 } };
  }

  // Build a summary of each page: title + first ~200 chars
  const summaries: string[] = [];
  for (const f of files) {
    const content = getFile(db, wikiId, f.path)?.content;
    const preview = content ? content.slice(0, PAGE_PREVIEW_LENGTH).replace(/\n/g, " ") : "(empty)";
    summaries.push(`- ${f.path}: ${preview}`);
  }

  const result = await chatFn({
    description: `Wiki ${config.name} — consolidation plan`,
    messages: [
      {
        role: "system",
        content: `Identify wiki pages that overlap in topic and should be merged into one page. If pages are about the same thing, merge them.

Respond with ONLY valid JSON matching this schema:
{
  "merge": [
    { "into": "target-page.md", "from": ["redundant-page.md"], "reason": "..." }
  ],
  "remove": [
    { "page": "useless-page.md", "redirect": "better-page.md", "reason": "..." }
  ]
}

Rules:
- "into" is the page to keep (or a new slug if renaming). "from" pages will be deleted after merging.
- "redirect" is the page that links to the removed page should point to instead.
- If no consolidation is needed, return {"merge":[], "remove":[]}.`,
      },
      {
        role: "user",
        content: `Review these wiki pages for the "${config.name}" project. Identify any that should be merged or removed.\n\n${summaries.join("\n")}`,
      },
    ],
  });

  let plan: MergePlan = { merge: [], remove: [] };
  try {
    const cleaned = result.content.replace(/```(?:json)?\n?/g, "").replace(/```$/g, "").trim();
    plan = JSON.parse(cleaned);
    if (!Array.isArray(plan.merge)) plan.merge = [];
    if (!Array.isArray(plan.remove)) plan.remove = [];
  } catch {
    log.warn("Failed to parse consolidation plan", { wiki: config.name });
  }

  return { plan, usage: result.usage };
}

/**
 * Rewrite all links pointing to oldPath so they point to newPath instead.
 * Updates both wiki_files content and the FTS index.
 */
async function rewriteLinks(
  db: Database,
  wikiId: number,
  oldPath: string,
  newPath: string,
): Promise<string[]> {
  const affected: string[] = [];
  const files = listFiles(db, wikiId).filter((f) => f.path.endsWith(".md"));

  for (const f of files) {
    const content = getFile(db, wikiId, f.path)?.content;
    if (!content) continue;

    // Match markdown links and bare [page.md] references
    const linkPattern = new RegExp(
      `(\\[[^\\]]*\\])\\(${escapeRegex(oldPath)}\\)|\\[${escapeRegex(oldPath)}\\](?!\\()`,
      "g",
    );

    const newContent = content.replace(linkPattern, (match, linkText) => {
      if (linkText) {
        // [text](old.md) → [text](new.md)
        return `${linkText}(${newPath})`;
      }
      // [old.md] → [new.md]
      return `[${newPath}]`;
    });

    if (newContent !== content) {
      const now = new Date().toISOString();
      upsertFile(db, wikiId, f.path, newContent, now);
      await indexFile(db, wikiId, "wiki_chunks", f.path, newContent, { embeddings: true });
      affected.push(f.path);
    }
  }

  return affected;
}

/**
 * Delete a wiki page and its chunks/FTS entries.
 */
function removePage(db: Database, wikiId: number, path: string): void {
  deleteFile(db, wikiId, path);
  removeFile(db, wikiId, "wiki_chunks", path);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Run the consolidation pass: plan, merge, remove, rewrite links.
 */
export async function consolidatePages(
  db: Database,
  wikiId: number,
  config: ConsolidateConfig,
  chatFn: ChatFn,
  result: ConsolidateResult,
): Promise<void> {
  const files = listFiles(db, wikiId).filter(
    (f) => f.path.endsWith(".md") && !SPECIAL.has(f.path),
  );

  // Only run consolidation when there are enough pages to potentially overlap
  if (files.length < 4) return;

  log.info(`Running consolidation pass (${files.length} pages)`, { wiki: config.name });

  const { plan, usage } = await planConsolidation(db, wikiId, config, chatFn);
  result.usage.input_tokens += usage.input_tokens;
  result.usage.output_tokens += usage.output_tokens;

  if (plan.merge.length === 0 && plan.remove.length === 0) {
    log.info("No consolidation needed", { wiki: config.name });
    return;
  }

  log.info(
    `Consolidation plan: ${plan.merge.length} merges, ${plan.remove.length} removals`,
    { wiki: config.name },
  );

  // --- Process merges ---
  for (const merge of plan.merge) {
    const sourceContents: string[] = [];
    const allOldPaths = merge.from;

    // Collect content from all pages being merged
    for (const path of [merge.into, ...merge.from]) {
      const content = getFile(db, wikiId, path)?.content;
      if (content) {
        sourceContents.push(`--- ${path} ---\n${content}`);
      }
    }

    if (sourceContents.length < 2) {
      log.warn(`Merge skipped — not enough content for ${merge.into}`, { wiki: config.name });
      continue;
    }

    const targetName = merge.into.replace(/\.md$/, "").replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

    // Ask LLM to produce the merged page
    log.info(`Merging ${merge.from.join(", ")} into ${merge.into} (calling LLM...)`, { wiki: config.name });

    try {
      const allPages = listFiles(db, wikiId)
        .filter((f) => f.path.endsWith(".md") && !merge.from.includes(f.path))
        .map((f) => f.path)
        .join("\n");

      const llmResult = await chatFn({
        description: `Wiki ${config.name} — merge into ${merge.into}`,
        messages: [
          {
            role: "system",
            content: `You are a wiki maintainer for the "${config.name}" project. You are merging several overlapping wiki pages into one unified page.

Rules:
- Combine the best content from all source pages — do not lose important information
- Remove redundancy — don't repeat the same concept twice
- Use headings (##, ###) to structure content clearly
- ONLY link to pages in the "Wiki pages" list below
- Use relative markdown links like [Page Name](page-name.md)
- Output ONLY the markdown content for the merged page`,
          },
          {
            role: "user",
            content: `Merge these pages into a single page called "${targetName}" (${merge.into}).

Reason for merge: ${merge.reason}

Wiki pages (ONLY link to these — the merged-away pages will no longer exist):
${allPages}

Pages to merge:
${sourceContents.join("\n\n")}`,
          },
        ],
      });

      result.usage.input_tokens += llmResult.usage.input_tokens;
      result.usage.output_tokens += llmResult.usage.output_tokens;

      const content = llmResult.content
        .replace(/^```(?:markdown|md)?\n/m, "")
        .replace(/\n```$/m, "")
        .trim();

      if (!content) continue;

      // Write the merged page
      const now = new Date().toISOString();
      upsertFile(db, wikiId, merge.into, content, now);
      await indexFile(db, wikiId, "wiki_chunks", merge.into, content, { embeddings: true });

      // Rewrite links and delete old pages
      for (const oldPath of allOldPaths) {
        await rewriteLinks(db, wikiId, oldPath, merge.into);
        removePage(db, wikiId, oldPath);
        log.info(`Deleted merged page ${oldPath}`, { wiki: config.name });
      }

      result.pagesUpdated.push(merge.into);
      recordUpdate(db, wikiId, merge.into, `Merged: ${merge.from.join(", ")} → ${merge.into}`);

      log.info(`Merged ${merge.from.length + 1} pages into ${merge.into}`, { wiki: config.name });
    } catch (e) {
      log.error(`Merge failed for ${merge.into}`, { wiki: config.name, error: (e as Error).message });
    }
  }

  // --- Process removals ---
  for (const removal of plan.remove) {
    const exists = getFile(db, wikiId, removal.page);
    if (!exists) continue;

    // Rewrite links to point to the redirect target
    const affected = await rewriteLinks(db, wikiId, removal.page, removal.redirect);

    removePage(db, wikiId, removal.page);
    recordUpdate(db, wikiId, removal.page, `Removed: ${removal.reason} (→ ${removal.redirect})`);

    log.info(`Removed ${removal.page} → ${removal.redirect} (rewrote links in ${affected.length} pages)`, { wiki: config.name });
  }
}
