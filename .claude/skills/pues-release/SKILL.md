---
name: pues-release
description: Cut a Pues release with dj — bump package.json, log docs/pues/TAGS.md, dj commit as chore(release), dj tag a v-prefixed tag, push, and dj release publish the notes. Use when tagging a new Pues version so consumers can pin which version they vendored.
---
# Pues Release (tagging)

## Purpose
Pues is a *peer source* that consumers vendor from `../pues`. A tag is how a
consumer records which version of Pues it copied (see `docs/pues/AI_PLAN.md` — "cut a
pues tag at the end of each phase"). This skill is the checklist for cutting one
consistently. **Pues is dj-managed — drive everything through `dj`, never raw
`git`/`jj`.** (dj's tags are git tags underneath, but you reach them via `dj
tag` / `dj release`.)

## When to tag
Tag when something landed that a consumer would want to pin or adopt: a new
`base/<part>`, a behavior change in an existing part, or a meaningful fix.
Routine internal refactors that don't change the vendored surface don't need a
tag.

## Versioning
- **Tags are `v`-prefixed**: `v0.24.0` (the whole history uses this — match it).
- **`package.json` `version` must equal the latest tag** *without* the `v`
  (tag `v0.24.0` ⇒ `"version": "0.24.0"`). Keeping them in lockstep is the rule;
  if they've drifted, this is the moment to realign — set `version` to the tag
  you're cutting, not to whatever stale number is there.
- Semver intent: **minor** (`0.X.0`) for a new part or additive surface;
  **patch** (`0.X.Y`) for fixes/tweaks to an existing part.

## Steps
1. **Pick the version** — next minor for a new part, next patch for a fix. The
   current `package.json` `version` is the last release; bump from there.
   Cross-check `dj release list` (newest published row at the top).
2. **Bump `package.json`** `version` to match (no `v`).
3. **Log it in `docs/pues/TAGS.md`** — a new top entry (newest first): the version,
   a one-line scope, and 2–4 bullets of what changed. This is the human-readable
   changelog; `dj log` is the full record.
4. **`bun run smoke` must pass** (lint + test + tsc) before you commit or push.
   A red release tag is worse than a late one — never tag a version that doesn't
   pass smoke. Fix the failure first, then continue.
5. **Commit** with the house convention:
   `chore(release): vX.Y.Z — <short scope>` (e.g. `… — base/markdown`). Fold the
   feature/doc changes into this commit, or land them first and let the release
   commit carry just the bump + `TAGS.md` — either is fine. End the body with the
   `Co-Authored-By:` trailer. `dj commit` takes only `-m` (no `-F`): write the
   message to a file and pass `dj commit -m "$(cat msgfile)"` — never a heredoc.
   This advances `main` to the release commit; `@` becomes a fresh empty change.
6. **Tag the release commit**: `dj tag vX.Y.Z <commit>`. Pass the release
   commit id explicitly — bare `dj tag vX.Y.Z` tags git HEAD (which after
   `dj commit` is `@-`, the release commit), but naming the commit removes all
   doubt. Get it from `dj show @-` / `dj log`.
7. **Push commit + tags**: `dj push` (advances the `main` bookmark), then
   `dj push --tags`. Note `dj push --tags` pushes **all** local tags (git
   semantics) — expect a backlog of historical tags to flush the first time a
   Dojo's origin had none.
8. **Publish the release notes**: `dj release publish vX.Y.Z -t "TITLE" -m
   "NOTES"` (notes are Markdown, rendered in the PWA Releases tab). Without this
   the release stays `tagged` and shows untitled in the UI. Use the file +
   `"$(cat …)"` trick for multi-line notes, same as the commit message. Edit
   later with `dj release edit vX.Y.Z -t/-m`; undo with `dj release delete`.

## Verify
- `dj release show vX.Y.Z` reports `[released]` with the title + notes, at the
  commit you tagged.
- `dj release list` shows the new release at the top.

## After tagging
A consumer adopts the new version by pointing `../pues` at the tag (or a later
SHA), then `bun run pues` to re-vendor, and committing the updated `pues/` tree.
You don't do that here — it happens in the consumer repo.

## Checklist
- [ ] `bun run smoke` passes (lint + test + tsc) — never tag a red build.
- [ ] `package.json` `version` == the tag (minus `v`).
- [ ] `docs/pues/TAGS.md` has a new top entry for this version.
- [ ] Commit is `chore(release): vX.Y.Z — <scope>` with the Co-Authored-By trailer.
- [ ] `dj tag vX.Y.Z` points at the release commit.
- [ ] `dj push` + `dj push --tags` done.
- [ ] `dj release publish vX.Y.Z -t … -m …` done; `dj release show` reads `[released]`.
