/** Index, log, and description maintenance for a wiki. */
import type { Database } from "bun:sqlite";
import { indexFile } from "../indexer";
import { log } from "../log";
import { getFile, listFiles, upsertFile } from "../storage";
import { billedChat } from "./billing";
import { extractMarkdown, getSourceFile } from "./helpers";
import { type AgentResult, SPECIAL_PAGES, type WikiConfig } from "./types";

export async function updateIndex(
  db: Database,
  wikiId: number,
  config: WikiConfig,
  _agentResult: AgentResult,
): Promise<void> {
  const files = listFiles(db, wikiId);
  const pages = files.filter(
    (f) => f.path.endsWith(".md") && !SPECIAL_PAGES.has(f.path),
  );

  const pageList = pages.map((p) => {
    const name = p.path.replace(".md", "");
    const title = name
      .replace(/-/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());
    return { path: p.path, title, slug: name };
  });

  const pageListMd = pageList
    .map((p) => `- [${p.title}](${p.slug}.md)`)
    .join("\n");

  const readme = getSourceFile(db, wikiId, "README.md");
  const readmeContext = readme || "";

  log.info(`Generating index page for ${config.name} (calling LLM...)`, {
    wiki: config.name,
  });

  try {
    const result = await billedChat(db, wikiId, config, {
      description: `Wiki ${config.name} — index.md`,
      messages: [
        {
          role: "system",
          content: `You write concise wiki index pages. Output ONLY markdown. No meta-commentary.`,
        },
        {
          role: "user",
          content: `Write the index page for the "${config.name}" wiki. Include:
1. A brief intro paragraph explaining what ${config.name} is (2-3 sentences)
2. A "Pages" section with this exact list:

${pageListMd}

Source context about the project:
${readmeContext || "(none)"}`,
        },
      ],
    });

    const content = extractMarkdown(result.content);
    if (content) {
      const now = new Date().toISOString();
      upsertFile(db, wikiId, "index.md", content, now);
      await indexFile(db, wikiId, "wiki_chunks", "index.md", content, {
        embeddings: true,
      });
      return;
    }
  } catch (e) {
    log.warn("LLM index generation failed, using fallback", {
      error: (e as Error).message,
    });
  }

  // Fallback: static index
  let index = `# ${config.name}\n\n`;
  index += `Wiki for the ${config.name} project.\n\n`;
  index += `## Pages\n\n`;
  index += `${pageListMd}\n`;

  const now = new Date().toISOString();
  upsertFile(db, wikiId, "index.md", index, now);
  await indexFile(db, wikiId, "wiki_chunks", "index.md", index, {
    embeddings: true,
  });
}

export async function appendLog(
  db: Database,
  wikiId: number,
  _config: WikiConfig,
  result: AgentResult,
  reason?: string,
): Promise<void> {
  const existing = getFile(db, wikiId, "log.md");
  const date = new Date().toISOString().slice(0, 10);
  const time = new Date().toISOString().slice(11, 16);

  let entry = `\n## [${date} ${time}] agent run`;
  if (reason) entry += ` | ${reason}`;
  entry += `\n`;

  if (result.pagesCreated.length) {
    entry += `- Created: ${result.pagesCreated.join(", ")}\n`;
  }
  if (result.pagesUpdated.length) {
    entry += `- Updated: ${result.pagesUpdated.join(", ")}\n`;
  }
  entry += `- Tokens: ${result.usage.input_tokens} in / ${result.usage.output_tokens} out\n`;

  const content = (existing?.content || "# Changelog\n") + entry;
  const now = new Date().toISOString();
  upsertFile(db, wikiId, "log.md", content, now);
}

export async function updateDescription(
  db: Database,
  wikiId: number,
  config: WikiConfig,
): Promise<void> {
  const readme = getSourceFile(db, wikiId, "README.md");
  const context = readme || config.name;

  log.info(`Generating description for ${config.name} (calling LLM...)`, {
    wiki: config.name,
  });

  try {
    const result = await billedChat(db, wikiId, config, {
      description: `Wiki ${config.name} — description`,
      messages: [
        {
          role: "system",
          content:
            "Respond with exactly one sentence, no more than 100 characters. No quotes, no markdown.",
        },
        {
          role: "user",
          content: `Describe the "${config.name}" project in one short sentence.\n\nContext:\n${context || config.name}`,
        },
      ],
    });

    const desc = result.content.trim().replace(/^["']|["']$/g, "");
    if (desc) {
      db.prepare("UPDATE wikis SET description = ? WHERE id = ?").run(
        desc,
        wikiId,
      );
    }
  } catch (e) {
    log.warn("Description generation failed", {
      wiki: config.name,
      error: (e as Error).message,
    });
  }
}
