/**
 * Bidirectional sync for generated wiki markdown under wiki/ (not sources).
 * Uses POST /api/sync + /api/push + /api/pull — does not call /api/sources (no AI).
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";

import { Glob } from "bun";
import { hashContent } from "../../src/lib/storage.ts";
import type { Manifest } from "../../src/lib/sync.ts";

export async function buildWikiManifest(projectDir: string): Promise<Manifest> {
  const wikiDir = resolve(projectDir, "wiki");
  if (!existsSync(wikiDir)) return {};

  const manifest: Manifest = {};
  const glob = new Glob("**/*.md");
  for await (const file of glob.scan({ cwd: wikiDir, absolute: false })) {
    const fullPath = resolve(wikiDir, file);
    if (!existsSync(fullPath)) continue;
    const content = readFileSync(fullPath, "utf8");
    const modified = statSync(fullPath).mtime.toISOString();
    manifest[file] = { hash: hashContent(content), modified };
  }
  return manifest;
}

export interface WikiSyncResult {
  pushed: number;
  pulled: number;
}

/**
 * Exchange manifests with the server, push local pages, then pull remote updates.
 * Push runs before pull so local wins are not overwritten in the same round.
 */
export async function syncWikiPages(
  projectDir: string,
  wikiName: string,
  apiUrl: string,
  headers: Record<string, string>,
): Promise<WikiSyncResult> {
  const localManifest = await buildWikiManifest(projectDir);

  const syncRes = await fetch(`${apiUrl}/api/sync`, {
    method: "POST",
    headers,
    body: JSON.stringify({ wiki: wikiName, files: localManifest }),
  });
  if (!syncRes.ok) {
    throw new Error(`Wiki sync plan failed: ${syncRes.status}`);
  }

  const syncJson = (await syncRes.json()) as {
    ok: boolean;
    error?: string;
    data?: {
      push: string[];
      pull: string[];
    };
  };
  if (!syncJson.ok) {
    throw new Error(syncJson.error || "Wiki sync failed");
  }

  const plan = syncJson.data ?? { push: [], pull: [] };
  const wikiDir = resolve(projectDir, "wiki");
  let pushed = 0;

  if (plan.push.length > 0) {
    const files = plan.push.map((path) => {
      const fullPath = resolve(wikiDir, path);
      const content = readFileSync(fullPath, "utf8");
      const modified = statSync(fullPath).mtime.toISOString();
      return { path, content, modified };
    });

    const pushRes = await fetch(`${apiUrl}/api/push`, {
      method: "POST",
      headers,
      body: JSON.stringify({ wiki: wikiName, files }),
    });
    if (!pushRes.ok) {
      throw new Error(`Wiki push failed: ${pushRes.status}`);
    }
    const pushJson = (await pushRes.json()) as { ok: boolean; error?: string };
    if (!pushJson.ok) {
      throw new Error(pushJson.error || "Wiki push failed");
    }
    pushed = files.length;
  }

  let pulled = 0;
  if (plan.pull.length > 0) {
    const pullRes = await fetch(`${apiUrl}/api/pull`, {
      method: "POST",
      headers,
      body: JSON.stringify({ wiki: wikiName, paths: plan.pull }),
    });
    if (!pullRes.ok) {
      throw new Error(`Wiki pull failed: ${pullRes.status}`);
    }
    const pullJson = (await pullRes.json()) as {
      ok: boolean;
      data?: { files: { path: string; content: string }[] };
    };
    if (!pullJson.ok) {
      throw new Error("Wiki pull failed");
    }
    for (const file of pullJson.data?.files || []) {
      const filePath = resolve(wikiDir, file.path);
      mkdirSync(resolve(filePath, ".."), { recursive: true });
      writeFileSync(filePath, file.content);
    }
    pulled = pullJson.data?.files?.length ?? 0;
  }

  return { pushed, pulled };
}
