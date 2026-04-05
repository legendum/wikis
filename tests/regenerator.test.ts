/**
 * scheduleRegeneration with mocked runAgent.
 * Use import.meta.resolve so mock.module matches the same URL as regenerator → ./agent.
 */
import { describe, test, expect, mock } from "bun:test";
import { Database } from "bun:sqlite";

const runAgentMock = mock(() =>
  Promise.resolve({
    pagesCreated: [] as string[],
    pagesUpdated: [] as string[],
    usage: { input_tokens: 0, output_tokens: 0 },
  }),
);

mock.module(import.meta.resolve("../src/lib/agent.ts", import.meta.url), () => ({
  runAgent: runAgentMock,
}));

const { scheduleRegeneration } = await import("../src/lib/regenerator.ts");

describe("scheduleRegeneration", () => {
  const db = new Database(":memory:");
  const config = { name: "test-wiki" };

  test("debounce:false coalesces rapid calls into one runAgent", async () => {
    runAgentMock.mockClear();
    scheduleRegeneration("user1", db, 1, config, { debounce: false, reason: "t" });
    scheduleRegeneration("user1", db, 1, config, { debounce: false, reason: "t" });
    await new Promise((r) => setTimeout(r, 30));
    expect(runAgentMock).toHaveBeenCalledTimes(1);
  });

  test("debounce:false returns false while runAgent is in flight", async () => {
    runAgentMock.mockClear();
    let release!: () => void;
    const barrier = new Promise<void>((r) => {
      release = r;
    });
    runAgentMock.mockImplementationOnce(() =>
      barrier.then(() => ({
        pagesCreated: [],
        pagesUpdated: [],
        usage: { input_tokens: 0, output_tokens: 0 },
      })),
    );

    expect(scheduleRegeneration("user2", db, 2, config, { debounce: false })).toBe(true);
    await new Promise((r) => setTimeout(r, 10));
    expect(runAgentMock).toHaveBeenCalledTimes(1);

    expect(scheduleRegeneration("user2", db, 2, config, { debounce: false })).toBe(false);

    release();
    await new Promise((r) => setTimeout(r, 10));
  });
});
