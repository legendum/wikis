import { describe, expect, it } from "bun:test";
import {
  buildManifest,
  diffManifests,
  type Manifest,
} from "../../src/lib/sync";

describe("diffManifests", () => {
  it("returns empty plan when manifests match", () => {
    const m: Manifest = {
      "index.md": { hash: "abc", modified: "2026-04-04T12:00:00Z" },
    };
    const plan = diffManifests(m, m);
    expect(plan.push).toHaveLength(0);
    expect(plan.pull).toHaveLength(0);
    expect(plan.conflicts).toHaveLength(0);
  });

  it("detects new local file", () => {
    const local: Manifest = {
      "index.md": { hash: "abc", modified: "2026-04-04T12:00:00Z" },
      "pages/new.md": { hash: "def", modified: "2026-04-04T12:00:00Z" },
    };
    const remote: Manifest = {
      "index.md": { hash: "abc", modified: "2026-04-04T12:00:00Z" },
    };
    const plan = diffManifests(local, remote);
    expect(plan.push).toEqual(["pages/new.md"]);
  });

  it("detects new remote file", () => {
    const local: Manifest = {
      "index.md": { hash: "abc", modified: "2026-04-04T12:00:00Z" },
    };
    const remote: Manifest = {
      "index.md": { hash: "abc", modified: "2026-04-04T12:00:00Z" },
      "pages/new.md": { hash: "def", modified: "2026-04-04T12:00:00Z" },
    };
    const plan = diffManifests(local, remote);
    expect(plan.pull).toEqual(["pages/new.md"]);
  });

  it("detects local change (no lastKnown)", () => {
    const local: Manifest = {
      "index.md": { hash: "new-hash", modified: "2026-04-04T13:00:00Z" },
    };
    const remote: Manifest = {
      "index.md": { hash: "old-hash", modified: "2026-04-04T12:00:00Z" },
    };
    // Without lastKnown, both sides appear changed — conflict, local wins by timestamp
    const plan = diffManifests(local, remote);
    expect(plan.conflicts).toEqual(["index.md"]);
    expect(plan.push).toEqual(["index.md"]);
  });

  it("detects remote change when local unchanged", () => {
    const known: Manifest = {
      "index.md": { hash: "original", modified: "2026-04-04T11:00:00Z" },
    };
    const local: Manifest = {
      "index.md": { hash: "original", modified: "2026-04-04T11:00:00Z" },
    };
    const remote: Manifest = {
      "index.md": { hash: "updated", modified: "2026-04-04T13:00:00Z" },
    };
    const plan = diffManifests(local, remote, known);
    expect(plan.pull).toEqual(["index.md"]);
    expect(plan.push).toHaveLength(0);
    expect(plan.conflicts).toHaveLength(0);
  });

  it("detects local change when remote unchanged", () => {
    const known: Manifest = {
      "index.md": { hash: "original", modified: "2026-04-04T11:00:00Z" },
    };
    const local: Manifest = {
      "index.md": { hash: "updated", modified: "2026-04-04T13:00:00Z" },
    };
    const remote: Manifest = {
      "index.md": { hash: "original", modified: "2026-04-04T11:00:00Z" },
    };
    const plan = diffManifests(local, remote, known);
    expect(plan.push).toEqual(["index.md"]);
    expect(plan.pull).toHaveLength(0);
    expect(plan.conflicts).toHaveLength(0);
  });

  it("flags conflict when both sides changed — local wins by timestamp", () => {
    const known: Manifest = {
      "index.md": { hash: "original", modified: "2026-04-04T11:00:00Z" },
    };
    const local: Manifest = {
      "index.md": { hash: "local-edit", modified: "2026-04-04T14:00:00Z" },
    };
    const remote: Manifest = {
      "index.md": { hash: "remote-edit", modified: "2026-04-04T13:00:00Z" },
    };
    const plan = diffManifests(local, remote, known);
    expect(plan.conflicts).toEqual(["index.md"]);
    expect(plan.push).toEqual(["index.md"]); // local newer
    expect(plan.pull).toHaveLength(0);
  });

  it("flags conflict when both sides changed — remote wins by timestamp", () => {
    const known: Manifest = {
      "index.md": { hash: "original", modified: "2026-04-04T11:00:00Z" },
    };
    const local: Manifest = {
      "index.md": { hash: "local-edit", modified: "2026-04-04T13:00:00Z" },
    };
    const remote: Manifest = {
      "index.md": { hash: "remote-edit", modified: "2026-04-04T14:00:00Z" },
    };
    const plan = diffManifests(local, remote, known);
    expect(plan.conflicts).toEqual(["index.md"]);
    expect(plan.pull).toEqual(["index.md"]); // remote newer
    expect(plan.push).toHaveLength(0);
  });

  it("detects file deleted on remote", () => {
    const known: Manifest = {
      "old.md": { hash: "abc", modified: "2026-04-04T11:00:00Z" },
    };
    const local: Manifest = {
      "old.md": { hash: "abc", modified: "2026-04-04T11:00:00Z" },
    };
    const remote: Manifest = {};
    const plan = diffManifests(local, remote, known);
    expect(plan.deleteLocal).toEqual(["old.md"]);
  });

  it("detects file deleted locally", () => {
    const known: Manifest = {
      "old.md": { hash: "abc", modified: "2026-04-04T11:00:00Z" },
    };
    const local: Manifest = {};
    const remote: Manifest = {
      "old.md": { hash: "abc", modified: "2026-04-04T11:00:00Z" },
    };
    const plan = diffManifests(local, remote, known);
    expect(plan.deleteRemote).toEqual(["old.md"]);
  });

  it("handles complex multi-file scenario", () => {
    const known: Manifest = {
      "index.md": { hash: "a", modified: "2026-04-04T10:00:00Z" },
      "pages/old.md": { hash: "b", modified: "2026-04-04T10:00:00Z" },
      "pages/shared.md": { hash: "c", modified: "2026-04-04T10:00:00Z" },
    };
    const local: Manifest = {
      "index.md": { hash: "a-local", modified: "2026-04-04T12:00:00Z" },
      // pages/old.md deleted locally
      "pages/shared.md": { hash: "c", modified: "2026-04-04T10:00:00Z" },
      "pages/new-local.md": { hash: "d", modified: "2026-04-04T11:00:00Z" },
    };
    const remote: Manifest = {
      "index.md": { hash: "a", modified: "2026-04-04T10:00:00Z" },
      "pages/old.md": { hash: "b", modified: "2026-04-04T10:00:00Z" },
      "pages/shared.md": { hash: "c-remote", modified: "2026-04-04T11:00:00Z" },
      "pages/new-remote.md": { hash: "e", modified: "2026-04-04T11:00:00Z" },
    };

    const plan = diffManifests(local, remote, known);
    expect(plan.push).toContain("index.md"); // local changed
    expect(plan.push).toContain("pages/new-local.md"); // new local
    expect(plan.pull).toContain("pages/shared.md"); // remote changed
    expect(plan.pull).toContain("pages/new-remote.md"); // new remote
    expect(plan.deleteRemote).toContain("pages/old.md"); // deleted locally
  });
});

describe("buildManifest", () => {
  it("builds manifest from file list", () => {
    const manifest = buildManifest([
      { path: "index.md", hash: "abc", modified: "2026-04-04T12:00:00Z" },
      { path: "pages/a.md", hash: "def", modified: "2026-04-04T12:00:00Z" },
    ]);
    expect(Object.keys(manifest)).toHaveLength(2);
    expect(manifest["index.md"].hash).toBe("abc");
    expect(manifest["pages/a.md"].hash).toBe("def");
  });

  it("returns empty manifest for empty input", () => {
    expect(Object.keys(buildManifest([]))).toHaveLength(0);
  });
});
