#!/usr/bin/env bun
/**
 * Vendor selected parts of the peer ../pues into ./pues.
 *
 * `bun run pues` re-vendors; `bun run pues repo` re-bootstraps (refreshes
 * this script itself from the peer, then re-vendors); `bun run pues version`
 * prints the vendored pues version.
 *
 * Which parts to vendor is declared in config/pues.yaml under `pues:`.
 * The inter-part dependency graph (`PUES_MANIFEST`) lives in pues
 * itself at `base/core/manifest.ts`; the script bootstrap-copies the
 * `core/` part, then imports the manifest from the *local* vendored
 * copy, then copies the remaining parts. The peer pues is treated as
 * a file source only — never imported across the project boundary.
 *
 * This file is "constant across consumers" per SPEC §9.1: copy
 * verbatim during adoption; never branch by consumer.
 */

import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename } from "node:path";

const SRC_BASE = "../pues/base";
const DST_BASE = "pues/base";
const SRC_TYPES_BASE = "../pues/types/pues/base";
const DST_TYPES_BASE = "types/pues/base";
const SRC_DOCS = "../pues/docs";
const DST_DOCS = "pues/docs";
const SRC_TSCONFIG_TYPECHECK = "../pues/tsconfig.typecheck.json";
const DST_TSCONFIG_TYPECHECK = "tsconfig.typecheck.json";

// `bun run pues version` — the vendored pues version. Local-only (no peer
// checkout needed), so keep it above the peer guard.
if (process.argv[2] === "version") {
  const { puesAppMeta } = (await import(
    "../pues/base/core/puesAppMeta.generated"
  )) as { puesAppMeta: { puesVersion?: string } };
  console.log(puesAppMeta.puesVersion || "unstamped — run: bun run pues");
  process.exit(0);
}

if (!existsSync(SRC_BASE)) {
  console.error(
    "No pues checkout found next to this repo (expected ../pues).\n" +
      "Vendoring needs the peer: clone pues as a sibling folder, then re-run.\n" +
      "(`bun run pues version` works without one.)",
  );
  process.exit(1);
}

// `bun run pues repo` — re-bootstrap THIS repo: runs the peer's
// scripts/repo.ts against us, which refreshes scripts/pues.ts itself (the
// one file a plain vendor can't update) and then re-vendors via the fresh
// script. repo.ts resolves every path from its own location and `bun run`
// sets cwd to the package root, so the folder name is all it needs.
if (process.argv[2] === "repo") {
  const r = Bun.spawnSync(
    ["bun", "../pues/scripts/repo.ts", basename(process.cwd())],
    { stdout: "inherit", stderr: "inherit" },
  );
  process.exit(r.exitCode ?? 1);
}

const config = Bun.YAML.parse(await Bun.file("config/pues.yaml").text()) as {
  pues?: string[];
  core?: { name?: string };
};
const requested = config.pues ?? [];

if (requested.length === 0) {
  console.error("config/pues.yaml has no `pues:` list — nothing to vendor.");
  process.exit(1);
}

// Bootstrap: wipe, then copy `core/` so the local manifest is fresh.
await rm("pues", { recursive: true, force: true });
await rm("types/pues", { recursive: true, force: true });
await mkdir(DST_BASE, { recursive: true });
await cp(`${SRC_BASE}/core`, `${DST_BASE}/core`, { recursive: true });

if (!existsSync(`${DST_BASE}/core/manifest.ts`)) {
  console.error(
    `Bootstrap copy of base/core did not produce manifest.ts. ` +
      `Is the peer pues at ../pues up to date?`,
  );
  process.exit(1);
}

// Resolve transitive deps from the local vendored manifest.
const { resolveDeps } = await import("../pues/base/core/manifest");
const parts = resolveDeps(requested);
const auto = parts.filter((p) => !requested.includes(p));

// Copy the remaining parts. `core/` already done in the bootstrap.
for (const part of parts) {
  if (part === "core") continue;
  await cp(`${SRC_BASE}/${part}`, `${DST_BASE}/${part}`, { recursive: true });
}

const typedParts: string[] = [];
if (existsSync(SRC_TYPES_BASE)) {
  await mkdir(DST_TYPES_BASE, { recursive: true });
  for (const part of parts) {
    const src = `${SRC_TYPES_BASE}/${part}`;
    if (!existsSync(src)) continue;
    await cp(src, `${DST_TYPES_BASE}/${part}`, { recursive: true });
    typedParts.push(part);
  }
}

// Per-part consumer contract docs: pues/docs/<PART>.md, a flat twin of
// pues/base/ — one doc per vendored part (docs mirror the parts you have).
// Re-copied verbatim every run, so re-vendor IS the sync; no drift check.
// (Distinct from ../pues scripts/vendor.ts, which only guards base/vendor SDKs.)
const docParts: string[] = [];
if (existsSync(SRC_DOCS)) {
  await mkdir(DST_DOCS, { recursive: true });
  for (const part of parts) {
    const doc = `${part.toUpperCase()}.md`;
    const src = `${SRC_DOCS}/${doc}`;
    if (!existsSync(src)) continue;
    await cp(src, `${DST_DOCS}/${doc}`);
    docParts.push(part);
  }
  // Part-independent docs (read-me-first preamble + the assembled-service
  // guide) vendor always, regardless of which parts are selected.
  for (const doc of ["README.md", "WIRING.md"]) {
    const src = `${SRC_DOCS}/${doc}`;
    if (existsSync(src)) await cp(src, `${DST_DOCS}/${doc}`);
  }
}

if (existsSync(SRC_TSCONFIG_TYPECHECK)) {
  await cp(SRC_TSCONFIG_TYPECHECK, DST_TSCONFIG_TYPECHECK);
}

// Emit puesAppMeta.generated.ts so client code can read pues.yaml-derived
// constants without a server roundtrip or runtime YAML parser. Consumed by
// LoginScreen (appName / logoSrc defaults) and any other client primitives
// that want a "what app am I" signal. Falls back to defaultCoreName() (the
// consumer's checkout-folder basename) so a minimal pues.yaml without an
// explicit `core.name` still produces working defaults.
//
// `puesVersion` stamps WHICH pues was vendored: the peer's package.json
// version, kept in lockstep with the release tag by skills/pues-release.
// Committed with the vendored tree — greppable, diffable in review, and
// runtime-readable. Exact when the peer sits on a tag (the pinning
// workflow); a floating tip stamps the last cut version.
const { resolveCoreName } = await import("../pues/base/core/defaultRoot");
const appName = resolveCoreName(config);
const puesVersion =
  (
    JSON.parse(await Bun.file("../pues/package.json").text()) as {
      version?: string;
    }
  ).version ?? "unknown";
await Bun.write(
  `${DST_BASE}/core/puesAppMeta.generated.ts`,
  `// Auto-generated by scripts/pues.ts from config/pues.yaml — do not edit.\nexport const puesAppMeta = {\n  name: ${JSON.stringify(appName)},\n  puesVersion: ${JSON.stringify(puesVersion)},\n} as const;\n`,
);

console.log(
  `Vendored pues/base @ v${puesVersion}: ${parts.join(", ")}` +
    (auto.length > 0 ? ` (auto-pulled: ${auto.join(", ")})` : ""),
);
if (existsSync(SRC_TYPES_BASE)) {
  console.log(
    `...types/pues/base: ` +
      (typedParts.length > 0 ? typedParts.join(", ") : "(none)"),
  );
}
if (existsSync(SRC_DOCS)) {
  console.log(
    `...pues/docs: ` +
      (docParts.length > 0
        ? docParts.map((p) => p.toUpperCase()).join(", ")
        : "(none)"),
  );
}

// --- Skills & Cursor rules: re-synced verbatim from ../pues every run, so
// they evolve with pues just like base/ and types/. Only pues-owned skill
// dirs are touched; a consumer's own skills/rules are left alone. ---
async function syncSkills(
  sourceDir: string,
  targetDir: string,
): Promise<string[]> {
  if (!existsSync(sourceDir)) return [];
  await mkdir(targetDir, { recursive: true });
  const synced: string[] = [];
  for (const entry of await readdir(sourceDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const src = `${sourceDir}/${entry.name}`;
    if (!existsSync(`${src}/SKILL.md`)) continue;
    const dst = `${targetDir}/${entry.name}`;
    await rm(dst, { recursive: true, force: true });
    await cp(src, dst, { recursive: true });
    synced.push(entry.name);
  }
  return synced;
}

async function syncRules(
  sourceDir: string,
  targetDir: string,
): Promise<string[]> {
  if (!existsSync(sourceDir)) return [];
  await mkdir(targetDir, { recursive: true });
  const synced: string[] = [];
  for (const entry of await readdir(sourceDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".mdc")) continue;
    await rm(`${targetDir}/${entry.name}`, { force: true });
    await cp(`${sourceDir}/${entry.name}`, `${targetDir}/${entry.name}`);
    synced.push(entry.name);
  }
  return synced;
}

// Claude has no .cursor/rules equivalent — it auto-loads CLAUDE.md. Bridge the
// Cursor rules into Claude by maintaining a signed, managed @import block in
// ./CLAUDE.md (regenerated each run); the consumer's own CLAUDE.md is untouched.
async function linkClaudeRules(rules: string[]): Promise<void> {
  const begin =
    "<!-- BEGIN Pues-managed rules — do not edit; regenerated by scripts/pues.ts -->";
  const end = "<!-- END Pues-managed rules -->";
  let body = existsSync("CLAUDE.md") ? await readFile("CLAUDE.md", "utf8") : "";
  // Strip any prior managed block so re-runs are idempotent (no regex: plain slice).
  const i = body.indexOf(begin);
  if (i !== -1) {
    const j = body.indexOf(end, i);
    body = (body.slice(0, i) + body.slice(j + end.length)).trimEnd();
  } else {
    body = body.trimEnd();
  }
  if (rules.length > 0) {
    const imports = rules.map((r) => "@.cursor/rules/" + r).join("\n");
    const block = begin + "\n" + imports + "\n" + end;
    body = body.length > 0 ? body + "\n\n" + block + "\n" : block + "\n";
  } else if (body.length > 0) {
    body = body + "\n";
  }
  await writeFile("CLAUDE.md", body);
}

const claudeSkills = await syncSkills("../pues/skills", ".claude/skills");
await syncSkills("../pues/skills", ".cursor/skills");
const cursorRules = await syncRules("../pues/rules", ".cursor/rules");
await linkClaudeRules(cursorRules);
if (claudeSkills.length > 0) {
  console.log(`...skills: ${claudeSkills.join(", ")}`);
}
if (cursorRules.length > 0) {
  console.log(`...rules: ${cursorRules.join(", ")}`);
}
