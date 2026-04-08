/**
 * Wiki agent — orchestrates the per-wiki build pipeline.
 *
 * The agent:
 * 1. Plans sections (or reuses existing pages)
 * 2. For each section: picks source files, builds prompts, calls LLM, writes pages
 * 3. Regenerates pages whose source files changed
 * 4. Fills missing links, consolidates redundant pages
 * 5. Updates index, log, and description
 *
 * Helpers live in `./agent/*.ts` — this file is the entrypoint and re-exports
 * the public surface for backwards-compatible imports.
 */
import type { Database } from "bun:sqlite";
import { billedChat } from "./agent/billing";
import {
  extractMarkdown,
  findChangedPages,
  getSourceFile,
  getSourcePaths,
  getSourceTree,
  setWikiPaths,
  slugify,
} from "./agent/helpers";
import { appendLog, updateDescription, updateIndex } from "./agent/meta";
import { fillMissingPages, summarizeChange } from "./agent/pages";
import {
  buildMessages,
  DEFAULT_SECTIONS,
  pickFilesForSection,
  planSections,
} from "./agent/sections";
import {
  type AgentResult,
  SPECIAL_PAGES,
  type WikiConfig,
} from "./agent/types";
import { consolidatePages } from "./consolidate";
import { indexFile } from "./indexer";
import { log } from "./log";
import { getFile, listFiles, upsertFile } from "./storage";

export type { AgentResult, WikiConfig };
// Public re-exports — keep external imports stable.
export { extractMarkdown, fillMissingPages };

/**
 * Run the wiki agent for a given wiki.
 * Called when source changes are detected.
 */
export async function runAgent(
  db: Database,
  wikiId: number,
  config: WikiConfig,
  opts: { reason?: string; force?: boolean } = {},
): Promise<AgentResult> {
  const result: AgentResult = {
    pagesUpdated: [],
    pagesCreated: [],
    usage: { input_tokens: 0, output_tokens: 0 },
  };

  // Plan sections if not provided — but skip if wiki already has pages
  let sections = config.sections;
  if (!sections || sections.length === 0) {
    const existingPages = listFiles(db, wikiId).filter(
      (f) => f.path.endsWith(".md") && !SPECIAL_PAGES.has(f.path),
    );
    if (existingPages.length > 0 && !opts.force) {
      log.info(
        `${config.name}: ${existingPages.length} pages already exist, skipping section planning`,
        { wiki: config.name },
      );
      sections = existingPages.map((f) => {
        const name = f.path
          .replace(/\.md$/, "")
          .replace(/-/g, " ")
          .replace(/\b\w/g, (c) => c.toUpperCase());
        return { name, description: "" };
      });
    } else {
      try {
        const plan = await planSections(db, wikiId, config);
        sections = plan.sections;
        result.usage.input_tokens += plan.usage.input_tokens;
        result.usage.output_tokens += plan.usage.output_tokens;
      } catch (e) {
        log.error("Section planning failed, using defaults", {
          wiki: config.name,
          error: (e as Error).message,
        });
        sections = DEFAULT_SECTIONS;
      }
    }
  }

  // Shared chat function for consolidation passes
  const chatFn = (chatOpts: {
    messages: import("./ai").ChatMessage[];
    description?: string;
  }) => billedChat(db, wikiId, config, chatOpts);

  // Consolidate existing pages before planning new ones
  await consolidatePages(db, wikiId, config, chatFn, result);

  // Build source tree once for all sections
  const tree = getSourceTree(db, wikiId);

  // Process each section — only create pages that don't exist yet.
  for (const section of sections) {
    const pagePath = `${slugify(section.name)}.md`;
    const existing = getFile(db, wikiId, pagePath);

    if (existing?.content && !opts.force) {
      log.info(`Section "${section.name}": already exists, skipping`, {
        wiki: config.name,
      });
      continue;
    }

    let selectedFiles: string[];
    try {
      const pick = await pickFilesForSection(db, wikiId, config, section, tree);
      selectedFiles = pick.files;
      result.usage.input_tokens += pick.usage.input_tokens;
      result.usage.output_tokens += pick.usage.output_tokens;
    } catch (e) {
      log.error(
        `Section "${section.name}": file selection failed, using all files`,
        { wiki: config.name, error: (e as Error).message },
      );
      selectedFiles = getSourcePaths(db, wikiId);
    }

    const sourceContent: string[] = [];
    for (const path of selectedFiles) {
      const content = getSourceFile(db, wikiId, path);
      if (content) sourceContent.push(`--- ${path} ---\n${content}`);
    }
    const sourceContext = sourceContent.join("\n\n");

    if (sourceContent.length === 0) {
      log.info(`Section "${section.name}": skipped (no source files found)`, {
        wiki: config.name,
      });
      continue;
    }

    const action = existing?.content ? "regenerating" : "creating";
    log.info(
      `Section "${section.name}": ${sourceContent.length} source files, ${action} (calling LLM...)`,
      { wiki: config.name },
    );

    const allPages = sections.map((s) => `${slugify(s.name)}.md`).join("\n");
    const messages = buildMessages(
      config,
      section,
      sourceContext,
      existing?.content || null,
      allPages,
    );

    let llmResult: import("./ai").ChatResult;
    try {
      llmResult = await billedChat(db, wikiId, config, {
        messages,
        description: `Wiki ${config.name} — ${pagePath}`,
      });
      log.info(
        `Section "${section.name}": LLM responded (${llmResult.usage.output_tokens} tokens)`,
        { wiki: config.name },
      );
    } catch (e) {
      log.error(`Section "${section.name}": LLM failed`, {
        wiki: config.name,
        error: (e as Error).message,
      });
      continue;
    }

    result.usage.input_tokens += llmResult.usage.input_tokens;
    result.usage.output_tokens += llmResult.usage.output_tokens;

    const content = extractMarkdown(llmResult.content);
    if (!content) continue;

    const now = new Date().toISOString();
    upsertFile(db, wikiId, pagePath, content, now);
    await indexFile(db, wikiId, "wiki_chunks", pagePath, content, {
      embeddings: true,
    });
    setWikiPaths(db, wikiId, selectedFiles, pagePath);
    await summarizeChange(
      db,
      wikiId,
      config,
      pagePath,
      existing?.content || null,
      content,
    );
    if (existing?.content) {
      result.pagesUpdated.push(pagePath);
    } else {
      result.pagesCreated.push(pagePath);
    }
  }

  // Regenerate pages whose source files have changed since last build
  const changedPages = findChangedPages(db, wikiId);
  if (changedPages.size > 0) {
    log.info(
      `Found ${changedPages.size} pages to regenerate: ${[...changedPages].join(", ")}`,
      { wiki: config.name },
    );
  }
  for (const pagePath of changedPages) {
    const existing = getFile(db, wikiId, pagePath);
    if (!existing?.content) continue;

    const sourceRows = db
      .prepare(
        `SELECT path FROM source_files WHERE wiki_id = ? AND INSTR(wiki_paths, ?) > 0`,
      )
      .all(wikiId, pagePath) as { path: string }[];

    const sourceContent: string[] = [];
    for (const row of sourceRows.slice(0, 20)) {
      const content = getSourceFile(db, wikiId, row.path);
      if (content) sourceContent.push(`--- ${row.path} ---\n${content}`);
    }

    if (sourceContent.length === 0) continue;

    const pageName = pagePath
      .replace(/\.md$/, "")
      .replace(/-/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());
    log.info(
      `Regenerating "${pagePath}": ${sourceContent.length} source files changed (calling LLM...)`,
      { wiki: config.name },
    );

    const allPages = listFiles(db, wikiId)
      .filter((f) => f.path.endsWith(".md"))
      .map((f) => f.path)
      .join("\n");
    const messages = buildMessages(
      config,
      { name: pageName, description: "" },
      sourceContent.join("\n\n"),
      existing.content,
      allPages,
    );

    try {
      const llmResult = await billedChat(db, wikiId, config, {
        messages,
        description: `Wiki ${config.name} — ${pagePath}`,
      });
      result.usage.input_tokens += llmResult.usage.input_tokens;
      result.usage.output_tokens += llmResult.usage.output_tokens;

      const content = extractMarkdown(llmResult.content);
      if (content) {
        const now = new Date().toISOString();
        upsertFile(db, wikiId, pagePath, content, now);
        await indexFile(db, wikiId, "wiki_chunks", pagePath, content, {
          embeddings: true,
        });
        await summarizeChange(
          db,
          wikiId,
          config,
          pagePath,
          existing.content,
          content,
        );
        result.pagesUpdated.push(pagePath);
        log.info(
          `Regenerated "${pagePath}" (${llmResult.usage.output_tokens} tokens)`,
          { wiki: config.name },
        );
      }
    } catch (e) {
      log.error(`Failed to regenerate "${pagePath}"`, {
        wiki: config.name,
        error: (e as Error).message,
      });
    }
  }

  // Fill missing pages — find links to .md files that don't exist yet and create them
  await fillMissingPages(db, wikiId, config, result);

  // Consolidate redundant/overlapping pages
  await consolidatePages(db, wikiId, config, chatFn, result);

  const hasChanges =
    result.pagesCreated.length > 0 ||
    result.pagesUpdated.length > 0 ||
    opts.reason?.toLowerCase().includes("deleted") ||
    !!opts.force;

  if (hasChanges) {
    await updateDescription(db, wikiId, config);
    await updateIndex(db, wikiId, config, result);
    await appendLog(db, wikiId, config, result, opts.reason);
  } else {
    log.info(
      `No pages changed for ${config.name}, skipping index/description update`,
      { wiki: config.name },
    );
  }

  return result;
}
