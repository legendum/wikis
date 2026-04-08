/** Filling missing pages and summarizing changes. */
import type { Database } from "bun:sqlite";
import { type ChatMessage, chat } from "../ai";
import { indexFile } from "../indexer";
import { log } from "../log";
import { getFile, listFiles, recordUpdate, upsertFile } from "../storage";
import { billedChat } from "./billing";
import {
  extractMarkdown,
  getSourceFile,
  getSourcePaths,
  getSourceTree,
  setWikiPaths,
} from "./helpers";
import { pickFilesForSection } from "./sections";
import { type AgentResult, SPECIAL_PAGES, type WikiConfig } from "./types";

/**
 * Scan all wiki pages for links to .md files that don't exist, then generate them.
 * Uses the link text and surrounding context to inform the LLM what to write.
 * Runs recursively — newly created pages may themselves link to further missing pages.
 */
export async function fillMissingPages(
  db: Database,
  wikiId: number,
  config: WikiConfig,
  result: AgentResult,
  depth = 0,
): Promise<void> {
  const MAX_DEPTH = 3;
  if (depth >= MAX_DEPTH) return;

  const tree = getSourceTree(db, wikiId);
  const files = listFiles(db, wikiId);
  const allPaths = db
    .prepare("SELECT path FROM wiki_files WHERE wiki_id = ?")
    .all(wikiId) as { path: string }[];
  const existingPaths = new Set(allPaths.map((f) => f.path));

  // Collect missing links with context
  const missing = new Map<string, { linkText: string; contexts: string[] }>();
  const linkRe = /\[([^\]]+)\]\(([^)]+\.md)\)/g;

  for (const file of files) {
    if (!file.path.endsWith(".md")) continue;
    const content = getFile(db, wikiId, file.path)?.content;
    if (!content) continue;

    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      let match: RegExpExecArray | null;
      // biome-ignore lint/suspicious/noAssignInExpressions: regex loop pattern
      while ((match = linkRe.exec(lines[i])) !== null) {
        const href = match[2].replace(/^\.\//, "");
        if (existingPaths.has(href) || SPECIAL_PAGES.has(href)) continue;

        if (!missing.has(href)) {
          missing.set(href, { linkText: match[1], contexts: [] });
        }
        const start = Math.max(0, i - 2);
        const end = Math.min(lines.length, i + 3);
        missing
          .get(href)
          ?.contexts.push(
            `From ${file.path}:\n${lines.slice(start, end).join("\n")}`,
          );
      }
    }
  }

  if (missing.size === 0) return;

  log.info(
    `Found ${missing.size} missing pages to fill: ${[...missing.keys()].join(", ")}`,
    { wiki: config.name },
  );

  const allPages = [...existingPaths, ...missing.keys()]
    .filter((p) => p.endsWith(".md"))
    .join("\n");

  for (const [pagePath, info] of missing) {
    const pageName = pagePath
      .replace(/\.md$/, "")
      .replace(/-/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());

    let selectedFiles: string[];
    try {
      const pick = await pickFilesForSection(
        db,
        wikiId,
        config,
        { name: info.linkText, description: info.contexts[0] || info.linkText },
        tree,
      );
      selectedFiles = pick.files;
      result.usage.input_tokens += pick.usage.input_tokens;
      result.usage.output_tokens += pick.usage.output_tokens;
    } catch (e) {
      log.warn(`Filling "${pagePath}": file selection failed`, {
        wiki: config.name,
        error: (e as Error).message,
      });
      selectedFiles = getSourcePaths(db, wikiId).slice(0, 10);
    }
    const sourceContent: string[] = [];
    for (const p of selectedFiles) {
      const c = getSourceFile(db, wikiId, p);
      if (c) sourceContent.push(`--- ${p} ---\n${c}`);
    }
    const sourceContext = sourceContent.join("\n\n");

    const messages: ChatMessage[] = [
      {
        role: "system",
        content: `You are a wiki maintainer for the "${config.name}" project. You write clear, well-structured markdown wiki pages.

Rules:
- Write in third person, present tense
- Be concise but thorough
- Use headings (##, ###) to structure content
- Include code examples from sources when they clarify concepts — always close code fences
- ONLY link to pages in the "Wiki pages" list below
- Use relative markdown links like [Page Name](page-name.md)
- Do not include meta-commentary about the writing process
- Output ONLY the markdown content for the page`,
      },
      {
        role: "user",
        content: `Create the wiki page "${pageName}" (${pagePath}).

This page was referenced by other wiki pages in these contexts:
${info.contexts.join("\n\n")}

Wiki pages (ONLY link to these):
${allPages}

Source material from the project:
${sourceContext || "(no relevant sources found)"}`,
      },
    ];

    log.info(
      `Filling missing page "${pagePath}" (${sourceContent.length} source files, calling LLM...)`,
      { wiki: config.name },
    );

    try {
      const llmResult = await billedChat(db, wikiId, config, {
        messages,
        description: `Wiki ${config.name} — ${pagePath}`,
      });
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
      existingPaths.add(pagePath);
      result.pagesCreated.push(pagePath);
      await summarizeChange(db, wikiId, config, pagePath, null, content);

      log.info(
        `Filled missing page "${pagePath}" (${llmResult.usage.output_tokens} tokens)`,
        { wiki: config.name },
      );
    } catch (e) {
      log.error(`Failed to fill missing page "${pagePath}"`, {
        wiki: config.name,
        error: (e as Error).message,
      });
    }
  }

  // Recurse — newly created pages may link to further missing pages
  if (missing.size > 0) {
    await fillMissingPages(db, wikiId, config, result, depth + 1);
  }
}

/** Ask the LLM for a one-line summary of what changed on a page. */
export async function summarizeChange(
  db: Database,
  wikiId: number,
  _config: WikiConfig,
  pagePath: string,
  oldContent: string | null,
  newContent: string,
): Promise<void> {
  const action = oldContent ? "Updated" : "Created";
  try {
    const result = await chat({
      messages: [
        {
          role: "system",
          content:
            "Respond with exactly one sentence (max 80 chars) summarizing what changed. No quotes, no markdown, no period at the end.",
        },
        {
          role: "user",
          content: oldContent
            ? `Summarize the changes between old and new versions of "${pagePath}".\n\nOld:\n${oldContent.slice(0, 1000)}\n\nNew:\n${newContent.slice(0, 1000)}`
            : `Summarize what the new wiki page "${pagePath}" covers.\n\n${newContent.slice(0, 1000)}`,
        },
      ],
    });
    const summary = result.content.trim().replace(/\.+$/, "");
    if (summary) {
      recordUpdate(db, wikiId, pagePath, `${action}: ${summary}`);
    }
  } catch (e) {
    log.warn(`Change summary failed for "${pagePath}"`, {
      error: (e as Error).message,
    });
    recordUpdate(db, wikiId, pagePath, `${action} page`);
  }
}
