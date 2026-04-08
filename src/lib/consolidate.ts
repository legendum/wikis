/**
 * Post-build consolidation pass.
 *
 * After the agent generates all wiki pages, this module reviews the full
 * page list and asks the LLM to identify redundant/overlapping pages.
 * It then merges or removes pages and rewrites all cross-references.
 */
import type { Database } from "bun:sqlite";
import { extractMarkdown } from "./agent";
import type { ChatMessage } from "./ai";
import { PAGE_PREVIEW_LENGTH } from "./constants";
import { indexFile, removeFile } from "./indexer";
import { log } from "./log";
import {
  deleteFile,
  getFile,
  listFiles,
  recordUpdate,
  upsertFile,
} from "./storage";

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
}) => Promise<{
  content: string;
  usage: { input_tokens: number; output_tokens: number };
}>;

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
): Promise<{
  plan: MergePlan;
  usage: { input_tokens: number; output_tokens: number };
}> {
  const files = listFiles(db, wikiId).filter(
    (f) => f.path.endsWith(".md") && !SPECIAL.has(f.path),
  );

  if (files.length < 2) {
    return {
      plan: { merge: [], remove: [] },
      usage: { input_tokens: 0, output_tokens: 0 },
    };
  }

  // Build a summary of each page: title + first ~200 chars
  const summaries: string[] = [];
  for (const f of files) {
    const content = getFile(db, wikiId, f.path)?.content;
    const preview = content
      ? content.slice(0, PAGE_PREVIEW_LENGTH).replace(/\n/g, " ")
      : "(empty)";
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
    const cleaned = result.content.trim();
    plan = JSON.parse(cleaned);
    if (!Array.isArray(plan.merge)) plan.merge = [];
    if (!Array.isArray(plan.remove)) plan.remove = [];
  } catch (e) {
    log.warn("Failed to parse consolidation plan", {
      wiki: config.name,
      error: (e as Error).message,
    });
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

    const newContent = content.replace(linkPattern, (_match, linkText) => {
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
      await indexFile(db, wikiId, "wiki_chunks", f.path, newContent, {
        embeddings: true,
      });
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

/** Remove a wiki page from all source_files.wiki_paths that reference it. */
function removeWikiPath(db: Database, wikiId: number, wikiPath: string): void {
  const rows = db
    .prepare(
      "SELECT id, wiki_paths FROM source_files WHERE wiki_id = ? AND wiki_paths != ''",
    )
    .all(wikiId) as { id: number; wiki_paths: string }[];

  for (const row of rows) {
    const paths = row.wiki_paths
      .split(",")
      .filter((p) => p !== wikiPath && p !== "");
    if (paths.length !== row.wiki_paths.split(",").length) {
      db.prepare("UPDATE source_files SET wiki_paths = ? WHERE id = ?").run(
        paths.join(","),
        row.id,
      );
    }
  }
}

/** Add a wiki page to the wiki_paths of specific source files. */
function addWikiPath(
  db: Database,
  wikiId: number,
  sourcePaths: string[],
  wikiPath: string,
): void {
  for (const srcPath of sourcePaths) {
    const row = db
      .prepare(
        "SELECT wiki_paths FROM source_files WHERE wiki_id = ? AND path = ?",
      )
      .get(wikiId, srcPath) as { wiki_paths: string } | null;
    if (!row) continue;

    const existing = row.wiki_paths
      ? row.wiki_paths.split(",").filter((p) => p !== "")
      : [];
    if (!existing.includes(wikiPath)) {
      existing.push(wikiPath);
      db.prepare(
        "UPDATE source_files SET wiki_paths = ? WHERE wiki_id = ? AND path = ?",
      ).run(existing.join(","), wikiId, srcPath);
    }
  }
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
  const MAX_PASSES = 5;

  for (let pass = 1; pass <= MAX_PASSES; pass++) {
    const files = listFiles(db, wikiId).filter(
      (f) => f.path.endsWith(".md") && !SPECIAL.has(f.path),
    );

    if (files.length < 4) return;

    log.info(`Consolidation pass ${pass} (${files.length} pages)`, {
      wiki: config.name,
    });

    const { plan, usage } = await planConsolidation(db, wikiId, config, chatFn);
    result.usage.input_tokens += usage.input_tokens;
    result.usage.output_tokens += usage.output_tokens;

    if (plan.merge.length === 0 && plan.remove.length === 0) {
      log.info("No further consolidation needed", { wiki: config.name });
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

      // Collect source files that contributed to the pages being merged
      const contributingSources = new Set<string>();
      for (const oldPath of allOldPaths) {
        const rows = db
          .prepare(
            "SELECT path FROM source_files WHERE wiki_id = ? AND INSTR(wiki_paths, ?) > 0",
          )
          .all(wikiId, oldPath) as { path: string }[];

        for (const row of rows) {
          contributingSources.add(row.path);
        }
      }

      // Read source file contents for better quality
      const sourceFileContents: string[] = [];
      for (const srcPath of contributingSources) {
        const row = db
          .prepare(
            "SELECT content FROM source_files WHERE wiki_id = ? AND path = ?",
          )
          .get(wikiId, srcPath) as { content: string } | null;
        if (row?.content) {
          sourceFileContents.push(`--- Source: ${srcPath} ---\n${row.content}`);
        }
      }

      for (const path of [merge.into, ...merge.from]) {
        const content = getFile(db, wikiId, path)?.content;
        if (content) {
          sourceContents.push(`--- ${path} ---\n${content}`);
        }
      }

      if (sourceContents.length < 2) {
        log.warn(`Merge skipped — not enough content for ${merge.into}`, {
          wiki: config.name,
        });
        continue;
      }

      const targetName = merge.into
        .replace(/\.md$/, "")
        .replace(/-/g, " ")
        .replace(/\b\w/g, (c) => c.toUpperCase());

      log.info(
        `Merging ${merge.from.join(", ")} into ${merge.into} (calling LLM...)`,
        { wiki: config.name },
      );

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
- Use the source materials as the primary reference — they contain the original, high-quality information
- Combine the best content from both source materials and existing wiki pages
- Do not lose important information from the sources
- Remove redundancy — don't repeat the same concept twice
- Use headings (##, ###) to structure content clearly
- Include code examples when they clarify concepts — always close code fences with \`\`\`
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

Source materials (the original files that these wiki pages were based on):
${sourceFileContents.join("\n\n")}

Existing wiki pages to merge:
${sourceContents.join("\n\n")}`,
            },
          ],
        });

        result.usage.input_tokens += llmResult.usage.input_tokens;
        result.usage.output_tokens += llmResult.usage.output_tokens;

        const content = extractMarkdown(llmResult.content);

        if (!content) continue;

        const now = new Date().toISOString();
        upsertFile(db, wikiId, merge.into, content, now);
        await indexFile(db, wikiId, "wiki_chunks", merge.into, content, {
          embeddings: true,
        });

        for (const oldPath of allOldPaths) {
          await rewriteLinks(db, wikiId, oldPath, merge.into);
          removePage(db, wikiId, oldPath);
          log.info(`Deleted merged page ${oldPath}`, { wiki: config.name });
        }

        // Update wiki_paths: add merged page to sources, remove old pages
        addWikiPath(db, wikiId, Array.from(contributingSources), merge.into);
        for (const oldPath of allOldPaths) {
          removeWikiPath(db, wikiId, oldPath);
        }

        result.pagesUpdated.push(merge.into);
        recordUpdate(
          db,
          wikiId,
          merge.into,
          `Merged: ${merge.from.join(", ")} → ${merge.into}`,
        );

        log.info(`Merged ${merge.from.length + 1} pages into ${merge.into}`, {
          wiki: config.name,
        });
      } catch (e) {
        log.error(`Merge failed for ${merge.into}`, {
          wiki: config.name,
          error: (e as Error).message,
        });
      }
    }

    // --- Process removals ---
    for (const removal of plan.remove) {
      const exists = getFile(db, wikiId, removal.page);
      if (!exists) continue;

      const affected = await rewriteLinks(
        db,
        wikiId,
        removal.page,
        removal.redirect,
      );

      removePage(db, wikiId, removal.page);
      removeWikiPath(db, wikiId, removal.page); // Clean up wiki_paths
      recordUpdate(
        db,
        wikiId,
        removal.page,
        `Removed: ${removal.reason} (→ ${removal.redirect})`,
      );

      log.info(
        `Removed ${removal.page} → ${removal.redirect} (rewrote links in ${affected.length} pages)`,
        { wiki: config.name },
      );
    }
  }

  log.warn(`Consolidation hit max passes (${MAX_PASSES})`, {
    wiki: config.name,
  });
}
