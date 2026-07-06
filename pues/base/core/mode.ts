/**
 * Hosted vs self-hosted mode detection.
 *
 * Self-hosted is the default for FOSS users: a single well-known local
 * user owns everything, billing is skipped, and `<Legendum>` renders as
 * an empty no-op. Hosted mode is enabled automatically when
 * `LEGENDUM_API_KEY` is set in the environment — full bearer-token auth,
 * Legendum billing, "Login with Legendum" OAuth.
 *
 * Lives in `base/core/` (not `base/auth/`) because consumer `billing.ts`
 * also reads `isSelfHosted()` to short-circuit charges — keeping the
 * billing module decoupled from auth.
 */

let byLegendumOverride: boolean | null = null;

export function isByLegendum(): boolean {
  if (byLegendumOverride !== null) return byLegendumOverride;
  return !!process.env.LEGENDUM_API_KEY;
}

export function isSelfHosted(): boolean {
  return !isByLegendum();
}

/** Test helper: force hosted-mode on or off. Pass `null` to restore
 * env-based detection. */
export function setByLegendum(value: boolean | null): void {
  byLegendumOverride = value;
}

/** The well-known user email used in self-hosted mode. */
export const LOCAL_USER_EMAIL = "local@localhost";
