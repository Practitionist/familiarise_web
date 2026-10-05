/**
 * Enterprise feature flag helpers.
 *
 * Host and hybrid organization capabilities (`canHost`, `MemberRole.EXPERT`,
 * 3-way revenue splits, rate cards, and organization payouts) are gated by
 * `ENABLE_HOST_ORGS="true"` (matching `lib/feature-flags.ts`).
 */

export function isHostOrgsEnabled(): boolean {
  const raw = process.env.ENABLE_HOST_ORGS?.trim().toLowerCase();
  return raw === "true";
}

export const ENABLE_HOST_ORGS = isHostOrgsEnabled();
