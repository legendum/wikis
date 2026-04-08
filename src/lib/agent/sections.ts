/** Section planning, file selection, and per-page prompt building. */
import type { Database } from "bun:sqlite";
import type { ChatMessage } from "../ai";
import { chat } from "../ai";
import { PAGE_PREVIEW_LENGTH } from "../constants";
import { log } from "../log";
import { listFiles } from "../storage";
import { getSourceFile, getSourcePaths, getSourceTree } from "./helpers";
import { SPECIAL_PAGES, type WikiConfig } from "./types";

/** Ask the LLM to propose wiki sections based on source material. */
export async function planSections(
  db: Database,
  wikiId: number,
  config: WikiConfig,
): Promise<{
  sections: { name: string; description: string }[];
  usage: { input_tokens: number; output_tokens: number };
}> {
  const tree = getSourceTree(db, wikiId);
  const readme = getSourceFile(db, wikiId, "README.md");

  const existingPages = listFiles(db, wikiId)
    .filter((f) => f.path.endsWith(".md") && !SPECIAL_PAGES.has(f.path))
    .map((f) => f.path);

  log.info(`Planning sections for ${config.name} (calling LLM...)`, {
    wiki: config.name,
  });

  const result = await chat({
    messages: [
      {
        role: "system",
        content: `You are a wiki planner. Given a project's README and source directory tree, propose up to 24 wiki pages that would best document it. Each page should cover a distinct topic. Do NOT include an "index" or "home" page — that is generated separately.

Respond with ONLY a JSON array of objects, each with "name" and "description" fields. Example:
[
  {"name": "Architecture", "description": "System design, components, and data flow"},
  {"name": "API Reference", "description": "REST endpoints, request/response formats"}
]

Keep names short (1–3 words). Descriptions should be one sentence. Choose fewer pages for small projects, more for large ones. Each page must have a distinct topic — do not create multiple pages about the same thing.`,
      },
      {
        role: "user",
        content: `Propose wiki pages for the "${config.name}" project.

${existingPages.length > 0 ? `Existing pages (update or keep these, avoid creating overlapping ones):\n${existingPages.join("\n")}\n\n` : ""}${readme ? `README:\n${readme.slice(0, PAGE_PREVIEW_LENGTH)}\n\n` : ""}Directory tree:
${tree}`,
      },
    ],
  });

  let sections: { name: string; description: string }[] = [];
  try {
    const cleaned = result.content
      .replace(/```(?:json)?\n?/g, "")
      .replace(/```$/g, "")
      .trim();
    sections = JSON.parse(cleaned);
    if (!Array.isArray(sections)) sections = [];
    sections = sections.filter((s) => s.name && s.description);
  } catch (e) {
    log.warn("Failed to parse planned sections, using defaults", {
      wiki: config.name,
      error: (e as Error).message,
    });
    sections = DEFAULT_SECTIONS;
  }

  log.info(
    `Planned ${sections.length} sections for ${config.name}: ${sections.map((s) => s.name).join(", ")}`,
  );
  return { sections, usage: result.usage };
}

export const DEFAULT_SECTIONS = [
  {
    name: "Overview",
    description: "What this project does, its purpose, and key features",
  },
  {
    name: "Architecture",
    description:
      "How the system is designed — components, data flow, key decisions",
  },
  {
    name: "Getting Started",
    description: "Installation, setup, and configuration",
  },
];

/** Ask the LLM which source files are relevant for a section. */
export async function pickFilesForSection(
  db: Database,
  wikiId: number,
  config: WikiConfig,
  section: { name: string; description: string },
  tree: string,
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
        role: "system",
        content: `You select source files relevant to a wiki page. Given a directory tree and a page description, respond with ONLY a JSON array of file paths. Choose all files that could be relevant to the topic, even peripherally. Include up to 20 files to ensure comprehensive coverage.`,
      },
      {
        role: "user",
        content: `Which source files are relevant for the "${section.name}" wiki page?

Page description: ${section.description}

Directory tree:
${tree}`,
      },
    ],
  });

  let files: string[] = [];
  try {
    const cleaned = result.content.trim();
    files = JSON.parse(cleaned);
    if (!Array.isArray(files)) files = [];
    files = files.filter((f) => typeof f === "string");
  } catch (e) {
    log.warn(
      `Section "${section.name}": failed to parse file list, using all files`,
      { wiki: config.name, error: (e as Error).message },
    );
    files = getSourcePaths(db, wikiId);
  }

  log.info(`Section "${section.name}": selected ${files.length} files`, {
    wiki: config.name,
  });
  return { files, usage: result.usage };
}

export function buildMessages(
  config: WikiConfig,
  section: { name: string; description: string },
  sourceContext: string,
  existingContent: string | null,
  allPages: string,
): ChatMessage[] {
  return [
    {
      role: "system",
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
      role: "user",
      content: `${existingContent ? "Update" : "Create"} the wiki page for section "${section.name}".

Section description: ${section.description}

${existingContent ? `Current page content:\n\`\`\`markdown\n${existingContent}\n\`\`\`` : "This page does not exist yet."}

Wiki pages (ONLY link to these):\n${allPages}

Source material from the project:\n${sourceContext || "(no relevant sources found)"}`,
    },
  ];
}
