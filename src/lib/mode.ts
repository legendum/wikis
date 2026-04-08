/**
 * Hosted vs self-hosted mode detection.
 *
 * Self-hosted is the default for FOSS users: API auth is bypassed, billing
 * is skipped, and a single well-known local user (id 0) owns everything.
 *
 * Hosted mode (wikis.fyi) is enabled automatically when `LEGENDUM_API_KEY`
 * is set in the environment — full bearer-token auth, Legendum billing,
 * "Login with Legendum" OAuth on the website, etc.
 *
 * Mirrors the pattern used in depends.cc (src/server/middleware.ts).
 */

let byLegendumOverride: boolean | null = null;

export function isByLegendum(): boolean {
  if (byLegendumOverride !== null) return byLegendumOverride;
  return !!process.env.LEGENDUM_API_KEY;
}

export function isSelfHosted(): boolean {
  return !isByLegendum();
}

/**
 * Test helper: force hosted-mode on or off, ignoring the env var.
 * Pass `null` to restore env-based detection.
 */
export function setByLegendum(value: boolean | null): void {
  byLegendumOverride = value;
}

/** The well-known user id used in self-hosted mode. */
export const LOCAL_USER_ID = 0;
export const LOCAL_USER_EMAIL = "local@localhost";
