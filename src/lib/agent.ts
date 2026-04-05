/**
 * Wiki agent — uses LLM + RAG to build and maintain wiki pages.
 *
 * The agent:
 * 1. Reads the wiki config (sections, name)
 * 2. Queries FTS/RAG for relevant source chunks
 * 3. Asks the LLM to generate/update wiki pages
 * 4. Writes results to the wiki_files and wiki_chunks tables
 */
import type { Database } from 'bun:sqlite';
import { type ChatMessage, chat } from './ai';
import {
  type Reservation,
  release,
  reserve,
  settle,
  shouldBill,
} from './billing';
import { consolidatePages } from './consolidate';
import { indexFile } from './indexer';
import { log } from './log';
import { getFile, listFiles, recordUpdate, upsertFile } from './storage';

const SPECIAL_PAGES = new Set(['index.md', 'log.md']);

/** Get the directory tree of all source files for a wiki. */
function getSourceTree(db: Database, wikiId: number): string {
  const rows = db
    .prepare(
      'SELECT DISTINCT path FROM source_files WHERE wiki_id = ? ORDER BY path'
    )
    .all(wikiId) as { path: string }[];

  const dirs = new Set<string>();
  const lines: string[] = [];
  for (const row of rows) {
    const parts = row.path.split('/');
    for (let i = 0; i < parts.length - 1; i++) {
      const dirPath = parts.slice(0, i + 1).join('/');
      if (!dirs.has(dirPath)) {
        dirs.add(dirPath);
        lines.push(`${'  '.repeat(i)}${parts[i]}/`);
      }
    }
    lines.push(`${'  '.repeat(parts.length - 1)}${parts[parts.length - 1]}`);
  }
  return lines.join('\n');
}

/** Read a source file from the DB. */
function getSourceFile(
  db: Database,
  wikiId: number,
  path: string
): string | null {
  const row = db
    .prepare('SELECT content FROM source_files WHERE wiki_id = ? AND path = ?')
    .get(wikiId, path) as { content: string } | null;
  return row?.content ?? null;
}

/** Get all distinct source file paths. */
function getSourcePaths(db: Database, wikiId: number): string[] {
  const rows = db
    .prepare(
      'SELECT DISTINCT path FROM source_files WHERE wiki_id = ? ORDER BY path'
    )
    .all(wikiId) as { path: string }[];
  return rows.map((r) => r.path);
}

/** Ask the LLM which source files are relevant for a section. */
async function pickFilesForSection(
  db: Database,
  wikiId: number,
  config: WikiConfig,
  section: { name: string; description: string },
  tree: string
): Promise<{
  files: string[];
  usage: { input_tokens: number; output_tokens: number };
}> {
  log.info(`Section "${section.name}": picking source files (calling LLM...)`, {
    wiki: config.name,
  });

  const result = await chat({
    messages: [
      {
        role: 'system',
        content: `You select source files relevant to a wiki page. Given a directory tree and a page description, respond with ONLY a JSON array of file paths. Choose all files that could be relevant to the topic, even peripherally. Include up to 20 files to ensure comprehensive coverage.`,
      },
      {
        role: 'user',
        content: `Which source files are relevant for the "${section.name}" wiki page?

Page description: ${section.description}

Directory tree:
${tree}`,
      },
    ],
  });

  let files: string[] = [];
  try {
    const cleaned = result.content
      .replace(/```(?:json)?\n?/g, '')
      .replace(/```$/g, '')
      .trim();
    files = JSON.parse(cleaned);
    if (!Array.isArray(files)) files = [];
    files = files.filter((f) => typeof f === 'string');
  } catch {
    log.warn(
      `Section "${section.name}": failed to parse file list, using all files`,
      { wiki: config.name }
    );
    files = getSourcePaths(db, wikiId);
  }

  log.info(`Section "${section.name}": selected ${files.length} files`, {
    wiki: config.name,
  });
  return { files, usage: result.usage };
}

/** Record that these source files contribute to a wiki page. */
function setWikiPaths(
  db: Database,
  wikiId: number,
  sourcePaths: string[],
  wikiPath: string
): void {
  for (const srcPath of sourcePaths) {
    const row = db
      .prepare(
        'SELECT wiki_paths FROM source_files WHERE wiki_id = ? AND path = ?'
      )
      .get(wikiId, srcPath) as { wiki_paths: string } | null;
    if (!row) continue;

    const existing = row.wiki_paths ? row.wiki_paths.split(',') : [];
    if (!existing.includes(wikiPath)) {
      existing.push(wikiPath);
      db.prepare(
        'UPDATE source_files SET wiki_paths = ? WHERE wiki_id = ? AND path = ?'
      ).run(existing.join(','), wikiId, srcPath);
    }
  }
}

/** Find wiki pages that need regenerating because their source files changed. */
function findChangedPages(db: Database, wikiId: number): Set<string> {
  // Compare source_files.modified_at vs wiki_files.modified_at.
  // A source file modified after its wiki page was last built means
  // that wiki page needs regenerating.
  const rows = db
    .prepare(`
    SELECT sf.wiki_paths, sf.modified_at as src_modified
    FROM source_files sf
    WHERE sf.wiki_id = ? AND sf.wiki_paths != ''
  `)
    .all(wikiId) as { wiki_paths: string; src_modified: string }[];

  const pages = new Set<string>();
  for (const row of rows) {
    for (const wikiPath of row.wiki_paths.split(',')) {
      if (!wikiPath) continue;
      const wf = db
        .prepare(
          'SELECT modified_at FROM wiki_files WHERE wiki_id = ? AND path = ?'
        )
        .get(wikiId, wikiPath) as { modified_at: string } | null;
      if (wf && row.src_modified > wf.modified_at) {
        pages.add(wikiPath);
      }
    }
  }
  return pages;
}

export interface WikiConfig {
  name: string;
  sections?: { name: string; description: string }[];
  /** Legendum token for billing. Null = no billing (self-hosted or own API key). */
  legendumToken?: string | null;
  /** Whether user provides their own LLM API key (no billing). */
  userHasOwnKey?: boolean;
}

export interface AgentResult {
  pagesUpdated: string[];
  pagesCreated: string[];
  usage: { input_tokens: number; output_tokens: number };
}

import { PAGE_PREVIEW_LENGTH } from './constants';

const RESERVE_CREDITS = 50;

/**
 * Chat with billing: reserve → call LLM → settle.
 * Only bills when config has a legendumToken and user doesn't have their own key.
 */
async function billedChat(
  db: Database,
  wikiId: number,
  config: WikiConfig,
  options: { messages: ChatMessage[]; description?: string }
): Promise<{
  content: string;
  usage: { input_tokens: number; output_tokens: number };
}> {
  const projectTitle =
    config.name.charAt(0).toUpperCase() + config.name.slice(1);
  const description = options.description || `Wiki ${projectTitle}`;
  const bill = config.legendumToken && shouldBill(!!config.userHasOwnKey);
  let reservation: Reservation | null = null;

  if (bill) {
    reservation = await reserve(
      config.legendumToken!,
      RESERVE_CREDITS,
      description
    );
  }

  try {
    const result = await chat(options);

    await settle(
      reservation,
      config.legendumToken!,
      result.usage.input_tokens,
      result.usage.output_tokens,
      description,
      { db, wikiId }
    );

    return result;
  } catch (e) {
    await release(reservation);
    throw e;
  }
}

/**
 * Ask the LLM to propose wiki sections based on source material.
 */
async function planSections(
  db: Database,
  wikiId: number,
  config: WikiConfig
): Promise<{
  sections: { name: string; description: string }[];
  usage: { input_tokens: number; output_tokens: number };
}> {
  const tree = getSourceTree(db, wikiId);
  const readme = getSourceFile(db, wikiId, 'README.md');

  const existingPages = listFiles(db, wikiId)
    .filter((f) => f.path.endsWith('.md') && !SPECIAL_PAGES.has(f.path))
    .map((f) => f.path);

  log.info(`Planning sections for ${config.name} (calling LLM...)`, {
    wiki: config.name,
  });

  const result = await chat({
    messages: [
      {
        role: 'system',
        content: `You are a wiki planner. Given a project's README and source directory tree, propose up to 24 wiki pages that would best document it. Each page should cover a distinct topic. Do NOT include an "index" or "home" page — that is generated separately.

Respond with ONLY a JSON array of objects, each with "name" and "description" fields. Example:
[
  {"name": "Architecture", "description": "System design, components, and data flow"},
  {"name": "API Reference", "description": "REST endpoints, request/response formats"}
]

Keep names short (1–3 words). Descriptions should be one sentence. Choose fewer pages for small projects, more for large ones. Each page must have a distinct topic — do not create multiple pages about the same thing.`,
      },
      {
        role: 'user',
        content: `Propose wiki pages for the "${config.name}" project.

${existingPages.length > 0 ? `Existing pages (update or keep these, avoid creating overlapping ones):\n${existingPages.join('\n')}\n\n` : ''}${readme ? `README:\n${readme.slice(0, PAGE_PREVIEW_LENGTH)}\n\n` : ''}Directory tree:
${tree}`,
      },
    ],
  });

  let sections: { name: string; description: string }[] = [];
  try {
    const cleaned = result.content
      .replace(/```(?:json)?\n?/g, '')
      .replace(/```$/g, '')
      .trim();
    sections = JSON.parse(cleaned);
    if (!Array.isArray(sections)) sections = [];
    sections = sections.filter((s) => s.name && s.description);
  } catch {
    log.warn('Failed to parse planned sections, using defaults', {
      wiki: config.name,
    });
    sections = [
      {
        name: 'Overview',
        description: 'What this project does, its purpose, and key features',
      },
      {
        name: 'Architecture',
        description:
          'How the system is designed — components, data flow, key decisions',
      },
      {
        name: 'Getting Started',
        description: 'Installation, setup, and configuration',
      },
    ];
  }

  log.info(
    `Planned ${sections.length} sections for ${config.name}: ${sections.map((s) => s.name).join(', ')}`
  );
  return { sections, usage: result.usage };
}

/**
 * Run the wiki agent for a given wiki.
 * Called when source changes are detected.
 */
export async function runAgent(
  db: Database,
  wikiId: number,
  config: WikiConfig,
  opts: { reason?: string; force?: boolean } = {}
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
      (f) => f.path.endsWith('.md') && !SPECIAL_PAGES.has(f.path)
    );
    if (existingPages.length > 0 && !opts.force) {
      // Wiki already has pages — no need to re-plan
      log.info(
        `${config.name}: ${existingPages.length} pages already exist, skipping section planning`,
        { wiki: config.name }
      );
      sections = existingPages.map((f) => {
        const name = f.path
          .replace(/\.md$/, '')
          .replace(/-/g, ' ')
          .replace(/\b\w/g, (c) => c.toUpperCase());
        return { name, description: '' };
      });
    } else {
      try {
        const plan = await planSections(db, wikiId, config);
        sections = plan.sections;
        result.usage.input_tokens += plan.usage.input_tokens;
        result.usage.output_tokens += plan.usage.output_tokens;
      } catch (e) {
        log.error('Section planning failed, using defaults', {
          wiki: config.name,
          error: (e as Error).message,
        });
        sections = [
          {
            name: 'Overview',
            description:
              'What this project does, its purpose, and key features',
          },
          {
            name: 'Architecture',
            description:
              'How the system is designed — components, data flow, key decisions',
          },
          {
            name: 'Getting Started',
            description: 'Installation, setup, and configuration',
          },
        ];
      }
    }
  }

  // Shared chat function for consolidation passes
  const chatFn = (opts: {
    messages: import('./ai').ChatMessage[];
    description?: string;
  }) => billedChat(db, wikiId, config, opts);

  // Consolidate existing pages before planning new ones
  await consolidatePages(db, wikiId, config, chatFn, result);

  // Build source tree once for all sections
  const tree = getSourceTree(db, wikiId);

  // Process each section — only create pages that don't exist yet.
  // Subsequent updates happen via --fill (fillMissingPages) for new pages.
  for (const section of sections) {
    const pagePath = `${slugify(section.name)}.md`;
    const existing = getFile(db, wikiId, pagePath);

    if (existing?.content && !opts.force) {
      log.info(`Section "${section.name}": already exists, skipping`, {
        wiki: config.name,
      });
      continue;
    }

    // Pick which source files are relevant
    let selectedFiles: string[];
    try {
      const pick = await pickFilesForSection(db, wikiId, config, section, tree);
      selectedFiles = pick.files;
      result.usage.input_tokens += pick.usage.input_tokens;
      result.usage.output_tokens += pick.usage.output_tokens;
    } catch (e) {
      log.error(
        `Section "${section.name}": file selection failed, using all files`,
        { wiki: config.name, error: (e as Error).message }
      );
      selectedFiles = getSourcePaths(db, wikiId);
    }

    // Fetch the actual file contents
    const sourceContent: string[] = [];
    for (const path of selectedFiles) {
      const content = getSourceFile(db, wikiId, path);
      if (content) sourceContent.push(`--- ${path} ---\n${content}`);
    }
    const sourceContext = sourceContent.join('\n\n');

    if (sourceContent.length === 0) {
      log.info(`Section "${section.name}": skipped (no source files found)`, {
        wiki: config.name,
      });
      continue;
    }

    const action = existing?.content ? 'regenerating' : 'creating';
    log.info(
      `Section "${section.name}": ${sourceContent.length} source files, ${action} (calling LLM...)`,
      { wiki: config.name }
    );

    const allPages = sections.map((s) => `${slugify(s.name)}.md`).join('\n');
    const messages = buildMessages(
      config,
      section,
      sourceContext,
      existing?.content || null,
      allPages
    );

    let llmResult;
    try {
      llmResult = await billedChat(db, wikiId, config, {
        messages,
        description: `Wiki ${config.name} — ${pagePath}`,
      });
      log.info(
        `Section "${section.name}": LLM responded (${llmResult.usage.output_tokens} tokens)`,
        { wiki: config.name }
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
    await indexFile(db, wikiId, 'wiki_chunks', pagePath, content, {
      embeddings: true,
    });
    setWikiPaths(db, wikiId, selectedFiles, pagePath);
    await summarizeChange(
      db,
      wikiId,
      config,
      pagePath,
      existing?.content || null,
      content
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
      `Found ${changedPages.size} pages to regenerate: ${[...changedPages].join(', ')}`,
      { wiki: config.name }
    );
  }
  for (const pagePath of changedPages) {
    const existing = getFile(db, wikiId, pagePath);
    if (!existing?.content) continue;

    // Get source files that feed into this page (contained in comma-separated list)
    const sourceRows = db
      .prepare(
        `SELECT path FROM source_files WHERE wiki_id = ? AND INSTR(wiki_paths, ?) > 0`
      )
      .all(wikiId, pagePath) as { path: string }[];

    const sourceContent: string[] = [];
    for (const row of sourceRows.slice(0, 20)) {
      // Limit to 20 most relevant sources
      const content = getSourceFile(db, wikiId, row.path);
      if (content) sourceContent.push(`--- ${row.path} ---\n${content}`);
    }

    if (sourceContent.length === 0) continue;

    const pageName = pagePath
      .replace(/\.md$/, '')
      .replace(/-/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());
    log.info(
      `Regenerating "${pagePath}": ${sourceContent.length} source files changed (calling LLM...)`,
      { wiki: config.name }
    );

    const allPages = listFiles(db, wikiId)
      .filter((f) => f.path.endsWith('.md'))
      .map((f) => f.path)
      .join('\n');
    const messages = buildMessages(
      config,
      { name: pageName, description: '' },
      sourceContent.join('\n\n'),
      existing.content,
      allPages
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
        await indexFile(db, wikiId, 'wiki_chunks', pagePath, content, {
          embeddings: true,
        });
        await summarizeChange(
          db,
          wikiId,
          config,
          pagePath,
          existing.content,
          content
        );
        result.pagesUpdated.push(pagePath);
        log.info(
          `Regenerated "${pagePath}" (${llmResult.usage.output_tokens} tokens)`,
          { wiki: config.name }
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
    result.pagesCreated.length > 0 || result.pagesUpdated.length > 0;

  if (hasChanges) {
    // Only regenerate description/index when pages actually changed
    await updateDescription(db, wikiId, config);
    await updateIndex(db, wikiId, config, result);
    await appendLog(db, wikiId, config, result, opts.reason);
  } else {
    log.info(
      `No pages changed for ${config.name}, skipping index/description update`,
      { wiki: config.name }
    );
  }

  return result;
}

function buildMessages(
  config: WikiConfig,
  section: { name: string; description: string },
  sourceContext: string,
  existingContent: string | null,
  allPages: string
): ChatMessage[] {
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: `You are a wiki maintainer for the "${config.name}" project. You write clear, well-structured markdown wiki pages.

The wiki should explain the project to a model who has limited context and background knowledge. Assume the reader has never seen the codebase and needs to understand how things work and why.

Rules:
- Write in third person, present tense
- Be thorough — explain concepts, design decisions, and how components fit together
- Use headings (##, ###) to structure content
- Include code examples from sources when they clarify concepts — always close code fences
- ONLY link to pages in the "Wiki pages" list below — do not invent links to pages that don't exist
- Use relative markdown links like [Page Name](page-name.md)
- Do not include meta-commentary about the writing process
- Output ONLY the markdown content for the page`,
    },
    {
      role: 'user',
      content: `${existingContent ? 'Update' : 'Create'} the wiki page for section "${section.name}".

Section description: ${section.description}

${existingContent ? `Current page content:\n\`\`\`markdown\n${existingContent}\n\`\`\`` : 'This page does not exist yet.'}

Wiki pages (ONLY link to these):\n${allPages}

Source material from the project:\n${sourceContext || '(no relevant sources found)'}`,
    },
  ];

  return messages;
}

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
  depth = 0
): Promise<void> {
  const MAX_DEPTH = 3;
  if (depth >= MAX_DEPTH) return;

  const tree = getSourceTree(db, wikiId);
  const files = listFiles(db, wikiId);
  const existingPaths = new Set(files.map((f) => f.path));

  // Collect missing links with context
  const missing = new Map<string, { linkText: string; contexts: string[] }>();
  const linkRe = /\[([^\]]+)\]\(([^)]+\.md)\)/g;

  for (const file of files) {
    if (!file.path.endsWith('.md')) continue;
    const content = getFile(db, wikiId, file.path)?.content;
    if (!content) continue;

    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      let match;
      while ((match = linkRe.exec(lines[i])) !== null) {
        const href = match[2].replace(/^\.\//, '');
        if (existingPaths.has(href) || SPECIAL_PAGES.has(href)) continue;

        if (!missing.has(href)) {
          missing.set(href, { linkText: match[1], contexts: [] });
        }
        // Grab surrounding lines as context
        const start = Math.max(0, i - 2);
        const end = Math.min(lines.length, i + 3);
        missing
          .get(href)!
          .contexts.push(
            `From ${file.path}:\n${lines.slice(start, end).join('\n')}`
          );
      }
    }
  }

  if (missing.size === 0) return;

  log.info(
    `Found ${missing.size} missing pages to fill: ${[...missing.keys()].join(', ')}`,
    { wiki: config.name }
  );

  const allPages = [...existingPaths, ...missing.keys()]
    .filter((p) => p.endsWith('.md'))
    .join('\n');

  for (const [pagePath, info] of missing) {
    const pageName = pagePath
      .replace(/\.md$/, '')
      .replace(/-/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());

    // Search for relevant source material using the link text
    // Pick relevant source files for the missing page
    let selectedFiles: string[];
    try {
      const pick = await pickFilesForSection(
        db,
        wikiId,
        config,
        { name: info.linkText, description: info.contexts[0] || info.linkText },
        tree
      );
      selectedFiles = pick.files;
      result.usage.input_tokens += pick.usage.input_tokens;
      result.usage.output_tokens += pick.usage.output_tokens;
    } catch {
      selectedFiles = getSourcePaths(db, wikiId).slice(0, 10);
    }
    const sourceContent: string[] = [];
    for (const p of selectedFiles) {
      const c = getSourceFile(db, wikiId, p);
      if (c) sourceContent.push(`--- ${p} ---\n${c}`);
    }
    const sourceContext = sourceContent.join('\n\n');

    const messages: ChatMessage[] = [
      {
        role: 'system',
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
        role: 'user',
        content: `Create the wiki page "${pageName}" (${pagePath}).

This page was referenced by other wiki pages in these contexts:
${info.contexts.join('\n\n')}

Wiki pages (ONLY link to these):
${allPages}

Source material from the project:
${sourceContext || '(no relevant sources found)'}`,
      },
    ];

    log.info(
      `Filling missing page "${pagePath}" (${sourceContent.length} source files, calling LLM...)`,
      { wiki: config.name }
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
      await indexFile(db, wikiId, 'wiki_chunks', pagePath, content, {
        embeddings: true,
      });
      setWikiPaths(db, wikiId, selectedFiles, pagePath);
      existingPaths.add(pagePath);
      result.pagesCreated.push(pagePath);
      await summarizeChange(db, wikiId, config, pagePath, null, content);

      log.info(
        `Filled missing page "${pagePath}" (${llmResult.usage.output_tokens} tokens)`,
        { wiki: config.name }
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

/**
 * Extract markdown from LLM response (strip code fences if present).
 */
export function extractMarkdown(content: string): string | null {
  if (!content.trim()) return null;

  // Strip outer ```markdown ... ``` fences if present
  const extracted = content
    .replace(/^```(?:markdown|md)?\n?/, '')
    .replace(/\n?```$/, '')
    .trim();

  // Ensure all code blocks are properly closed
  return closeCodeBlocks(extracted);
}

function closeCodeBlocks(content: string): string {
  const lines = content.split('\n');
  let inCodeBlock = false;
  let codeBlockStart = '';
  const result: string[] = [];

  for (const line of lines) {
    if (line.startsWith('```')) {
      if (inCodeBlock) {
        // Closing a code block
        if (!line.trim().endsWith('```')) {
          result.push(line + '```');
        } else {
          result.push(line);
        }
        inCodeBlock = false;
      } else {
        // Starting a code block
        inCodeBlock = true;
        codeBlockStart = line;
        result.push(line);
      }
    } else {
      result.push(line);
    }
  }

  // If we're still in a code block at the end, close it
  if (inCodeBlock) {
    result.push('```');
  }

  return result.join('\n');
}

/** Ask the LLM for a one-line summary of what changed on a page. */
async function summarizeChange(
  db: Database,
  wikiId: number,
  config: WikiConfig,
  pagePath: string,
  oldContent: string | null,
  newContent: string
): Promise<void> {
  const action = oldContent ? 'Updated' : 'Created';
  try {
    const result = await chat({
      messages: [
        {
          role: 'system',
          content:
            'Respond with exactly one sentence (max 80 chars) summarizing what changed. No quotes, no markdown, no period at the end.',
        },
        {
          role: 'user',
          content: oldContent
            ? `Summarize the changes between old and new versions of "${pagePath}".\n\nOld:\n${oldContent.slice(0, 1000)}\n\nNew:\n${newContent.slice(0, 1000)}`
            : `Summarize what the new wiki page "${pagePath}" covers.\n\n${newContent.slice(0, 1000)}`,
        },
      ],
    });
    const summary = result.content.trim().replace(/\.+$/, '');
    if (summary) {
      recordUpdate(db, wikiId, pagePath, `${action}: ${summary}`);
    }
  } catch {
    recordUpdate(db, wikiId, pagePath, `${action} page`);
  }
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

async function updateIndex(
  db: Database,
  wikiId: number,
  config: WikiConfig,
  agentResult: AgentResult
): Promise<void> {
  const files = listFiles(db, wikiId);
  const pages = files.filter(
    (f) => f.path.endsWith('.md') && !SPECIAL_PAGES.has(f.path)
  );

  // Build page list for context
  const pageList = pages.map((p) => {
    const name = p.path.replace('.md', '');
    const title = name
      .replace(/-/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());
    return { path: p.path, title, slug: name };
  });

  // Ask the LLM to write a proper index
  const pageListMd = pageList
    .map((p) => `- [${p.title}](${p.slug}.md)`)
    .join('\n');

  // Get README for context
  const readme = getSourceFile(db, wikiId, 'README.md');
  const readmeContext = readme || '';

  log.info(`Generating index page for ${config.name} (calling LLM...)`, {
    wiki: config.name,
  });

  try {
    const result = await billedChat(db, wikiId, config, {
      description: `Wiki ${config.name} — index.md`,
      messages: [
        {
          role: 'system',
          content: `You write concise wiki index pages. Output ONLY markdown. No meta-commentary.`,
        },
        {
          role: 'user',
          content: `Write the index page for the "${config.name}" wiki. Include:
1. A brief intro paragraph explaining what ${config.name} is (2-3 sentences)
2. A "Pages" section with this exact list:

${pageListMd}

Source context about the project:
${readmeContext || '(none)'}`,
        },
      ],
    });

    const content = extractMarkdown(result.content);
    if (content) {
      const now = new Date().toISOString();
      upsertFile(db, wikiId, 'index.md', content, now);
      await indexFile(db, wikiId, 'wiki_chunks', 'index.md', content, {
        embeddings: true,
      });
      return;
    }
  } catch (e) {
    log.warn('LLM index generation failed, using fallback', {
      error: (e as Error).message,
    });
  }

  // Fallback: static index
  let index = `# ${config.name}\n\n`;
  index += `Wiki for the ${config.name} project.\n\n`;
  index += `## Pages\n\n`;
  index += pageListMd + '\n';

  const now = new Date().toISOString();
  upsertFile(db, wikiId, 'index.md', index, now);
  await indexFile(db, wikiId, 'wiki_chunks', 'index.md', index, {
    embeddings: true,
  });
}

async function appendLog(
  db: Database,
  wikiId: number,
  config: WikiConfig,
  result: AgentResult,
  reason?: string
): Promise<void> {
  const existing = getFile(db, wikiId, 'log.md');
  const date = new Date().toISOString().slice(0, 10);
  const time = new Date().toISOString().slice(11, 16);

  let entry = `\n## [${date} ${time}] agent run`;
  if (reason) entry += ` | ${reason}`;
  entry += `\n`;

  if (result.pagesCreated.length) {
    entry += `- Created: ${result.pagesCreated.join(', ')}\n`;
  }
  if (result.pagesUpdated.length) {
    entry += `- Updated: ${result.pagesUpdated.join(', ')}\n`;
  }
  entry += `- Tokens: ${result.usage.input_tokens} in / ${result.usage.output_tokens} out\n`;

  const content = (existing?.content || '# Changelog\n') + entry;
  const now = new Date().toISOString();
  upsertFile(db, wikiId, 'log.md', content, now);
}

async function updateDescription(
  db: Database,
  wikiId: number,
  config: WikiConfig
): Promise<void> {
  const readme = getSourceFile(db, wikiId, 'README.md');
  const context = readme || config.name;

  log.info(`Generating description for ${config.name} (calling LLM...)`, {
    wiki: config.name,
  });

  try {
    const result = await billedChat(db, wikiId, config, {
      description: `Wiki ${config.name} — description`,
      messages: [
        {
          role: 'system',
          content:
            'Respond with exactly one sentence, no more than 100 characters. No quotes, no markdown.',
        },
        {
          role: 'user',
          content: `Describe the "${config.name}" project in one short sentence.\n\nContext:\n${context || config.name}`,
        },
      ],
    });

    const desc = result.content.trim().replace(/^["']|["']$/g, '');
    if (desc) {
      db.prepare('UPDATE wikis SET description = ? WHERE id = ?').run(
        desc,
        wikiId
      );
    }
  } catch (e) {
    log.warn('Description generation failed', {
      wiki: config.name,
      error: (e as Error).message,
    });
  }
}
