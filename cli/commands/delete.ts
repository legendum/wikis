/**
 * wikis delete <page> — delete a wiki page locally and on the server.
 *
 * Usage:
 *   wikis delete git-integration
 *   wikis delete "git integration"
 */
import { existsSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import yaml from "js-yaml";
import { getAccountKey, getApiUrl } from "../lib/config";

export default async function deletePage(args: string[]) {
  let pageName = args[0];
  if (!pageName) {
    console.error("Usage: wikis delete <page>");
    console.error("Example: wikis delete git-integration");
    process.exit(1);
  }
  if (pageName.endsWith(".md")) pageName = pageName.slice(0, -3);

  const projectDir = process.cwd();
  const wikiDir = resolve(projectDir, "wiki");
  const pagePath = resolve(wikiDir, `${pageName}.md`);

  // Check if wiki exists
  const configPath = resolve(wikiDir, "config.yml");
  if (!existsSync(configPath)) {
    console.error('No wiki found in this project. Run "wikis init" first.');
    process.exit(1);
  }

  // Read config to get wiki name
  const config = yaml.load(readFileSync(configPath, "utf8")) as {
    name: string;
  };
  const wikiName = config.name;

  // Check if page exists locally
  if (!existsSync(pagePath)) {
    console.error(`Page "${pageName}.md" not found in wiki/ directory.`);
    return;
  }

  const accountKey = getAccountKey();
  if (!accountKey) {
    console.error("Not authenticated. Run 'wikis login' first.");
    process.exit(1);
  }

  const apiUrl = getApiUrl();
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${accountKey}`,
  };

  console.log(`Deleting page: ${pageName}...`);

  let serverDeleted = false;

  // Delete from server first
  try {
    const response = await fetch(
      `${apiUrl}/api/wikis/${encodeURIComponent(wikiName)}/pages/${encodeURIComponent(pageName)}`,
      {
        method: "DELETE",
        headers,
      },
    );

    if (response.ok) {
      console.log(`✅ Removed "${pageName}" from server.`);
      serverDeleted = true;
    } else {
      console.error(
        `⚠️ Server returned ${response.status}: ${response.statusText}`,
      );
    }
  } catch (e) {
    console.error(`⚠️ Failed to remove from server: ${(e as Error).message}`);
  }

  // Delete locally
  try {
    rmSync(pagePath, { force: true });
    console.log(`✅ Deleted local file: wiki/${pageName}.md`);
  } catch (e) {
    console.error(`⚠️ Failed to delete local file: ${(e as Error).message}`);
  }

  if (serverDeleted) {
    console.log("🔄 Triggering index regeneration...");
    try {
      await fetch(`${apiUrl}/api/rebuild`, {
        method: "POST",
        headers,
        body: JSON.stringify({ wiki: wikiName, force: false }),
      });
      console.log("✅ Index regeneration triggered (this may take a moment).");
    } catch (e) {
      console.error(
        `⚠️ Failed to trigger index regeneration: ${(e as Error).message}`,
      );
      console.log('💡 Run "wikis sync" to update the index.md manually.');
    }
  }

  console.log("Done.");
}
