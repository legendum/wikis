import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";

/**
 * Smoke tests for the CLI entrypoint. We spawn `bun cli/main.ts` as a
 * subprocess and inspect stdout/stderr/exit code, which exercises the real
 * command dispatch and error-handling wrapper without depending on any
 * particular subcommand's behaviour.
 */

const CLI = resolve(import.meta.dir, "../../cli/main.ts");

async function runCli(args: string[]) {
  const proc = Bun.spawn(["bun", CLI, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

describe("cli", () => {
  it("prints help with no arguments", async () => {
    const { stdout, exitCode } = await runCli([]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("wikis");
    expect(stdout).toContain("Commands:");
  });

  it("prints help for --help", async () => {
    const { stdout, exitCode } = await runCli(["--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Commands:");
  });

  it("prints help for the help command", async () => {
    const { stdout, exitCode } = await runCli(["help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Commands:");
  });

  it("prints version for --version", async () => {
    const { stdout, exitCode } = await runCli(["--version"]);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/wikis \d/);
  });

  it("rejects unknown commands with exit 1", async () => {
    const { stderr, exitCode } = await runCli(["definitely-not-a-command"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Unknown command");
  });

  it("lists all known commands in help", async () => {
    const { stdout } = await runCli(["--help"]);
    for (const cmd of [
      "init",
      "list",
      "login",
      "rebuild",
      "remove",
      "search",
      "serve",
      "start",
      "status",
      "stop",
      "sync",
      "update",
    ]) {
      expect(stdout).toContain(cmd);
    }
  });
});
