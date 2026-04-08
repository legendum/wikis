import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  isByLegendum,
  isSelfHosted,
  LOCAL_USER_EMAIL,
  LOCAL_USER_ID,
  setByLegendum,
} from "../../src/lib/mode";

/**
 * Tests for hosted/self-hosted mode detection. Mirrors the pattern used
 * in depends.cc — `LEGENDUM_API_KEY` presence is the single switch, with
 * `setByLegendum` available as a test-time override.
 */
describe("mode detection", () => {
  const originalKey = process.env.LEGENDUM_API_KEY;

  beforeEach(() => {
    setByLegendum(null);
    delete process.env.LEGENDUM_API_KEY;
  });

  afterEach(() => {
    setByLegendum(null);
    if (originalKey === undefined) {
      delete process.env.LEGENDUM_API_KEY;
    } else {
      process.env.LEGENDUM_API_KEY = originalKey;
    }
  });

  it("defaults to self-hosted when LEGENDUM_API_KEY is unset", () => {
    expect(isByLegendum()).toBe(false);
    expect(isSelfHosted()).toBe(true);
  });

  it("switches to hosted mode when LEGENDUM_API_KEY is set", () => {
    process.env.LEGENDUM_API_KEY = "lpk_test";
    expect(isByLegendum()).toBe(true);
    expect(isSelfHosted()).toBe(false);
  });

  it("treats an empty LEGENDUM_API_KEY as self-hosted", () => {
    process.env.LEGENDUM_API_KEY = "";
    expect(isByLegendum()).toBe(false);
    expect(isSelfHosted()).toBe(true);
  });

  it("setByLegendum(true) overrides the env var", () => {
    delete process.env.LEGENDUM_API_KEY;
    setByLegendum(true);
    expect(isByLegendum()).toBe(true);
    expect(isSelfHosted()).toBe(false);
  });

  it("setByLegendum(false) overrides the env var", () => {
    process.env.LEGENDUM_API_KEY = "lpk_test";
    setByLegendum(false);
    expect(isByLegendum()).toBe(false);
    expect(isSelfHosted()).toBe(true);
  });

  it("setByLegendum(null) restores env-based detection", () => {
    setByLegendum(true);
    expect(isByLegendum()).toBe(true);
    setByLegendum(null);
    expect(isByLegendum()).toBe(false);
  });

  it("exposes a stable local user identity", () => {
    expect(LOCAL_USER_ID).toBe(0);
    expect(LOCAL_USER_EMAIL).toBe("local@localhost");
  });
});
