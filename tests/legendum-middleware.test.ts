/**
 * Exercises `legendum.middleware()` for `POST …/link-key`.
 *
 * Todos does not ship HTTP tests for link-key (`tests/api.test.ts` unsets
 * `LEGENDUM_API_KEY`, so hosted middleware is never mounted). These tests call
 * the SDK handler directly with an injected `client` (middleware uses
 * `create()` internally when `client` is omitted, so `legendum.mock()` alone
 * does not apply to link-key).
 */
import { describe, expect, it } from "bun:test";
import legendum from "../src/lib/legendum.js";

describe("legendum.middleware POST /link-key", () => {
  it("returns 401 without Authorization", async () => {
    const mw = legendum.middleware({
      prefix: "/legendum",
      getToken: async () => null,
      setToken: async () => {},
      client: {
        linkAccount: async () => ({
          account_token: "should-not-run",
          email: "x@y.com",
        }),
      },
    });
    const res = await mw(
      new Request("https://example.com/legendum/link-key", { method: "POST" }),
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(401);
  });

  it("returns account_token and email from linkAccount", async () => {
    const mw = legendum.middleware({
      prefix: "/legendum",
      getToken: async () => null,
      setToken: async () => {},
      client: {
        linkAccount: async (key: string) => {
          expect(key).toBe("lak_foo");
          return { account_token: "acct_1", email: "u@test.com" };
        },
      },
    });
    const res = await mw(
      new Request("https://example.com/legendum/link-key", {
        method: "POST",
        headers: { Authorization: "Bearer lak_foo" },
      }),
    );
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as {
      account_token: string;
      email: string;
    };
    expect(body.account_token).toBe("acct_1");
    expect(body.email).toBe("u@test.com");
  });

  it("invokes onLinkKey after success", async () => {
    const seen: string[] = [];
    const mw = legendum.middleware({
      prefix: "/legendum",
      getToken: async () => null,
      setToken: async () => {},
      client: {
        linkAccount: async () => ({
          account_token: "t",
          email: "on@test.com",
        }),
      },
      onLinkKey: async (_req, accountToken, email) => {
        seen.push(accountToken, email ?? "");
      },
    });
    const res = await mw(
      new Request("https://example.com/legendum/link-key", {
        method: "POST",
        headers: { Authorization: "Bearer lak_x" },
      }),
    );
    expect(res!.status).toBe(200);
    expect(seen).toEqual(["t", "on@test.com"]);
  });
});
