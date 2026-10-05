/**
 * Enterprise feature flag helpers.
 *
 * Host and hybrid organization capabilities (`canHost`, `MemberRole.EXPERT`,
 * 3-way revenue splits, rate cards, and organization payouts) are enabled by
 * default and may be explicitly disabled per environment by setting
 * `ENABLE_HOST_ORGS="false"` or `ENABLE_HOST_ORGS="0"`.
 */

export function isHostOrgsEnabled(): boolean {
  const raw = process.env.ENABLE_HOST_ORGS?.trim().toLowerCase();
  if (raw === "false" || raw === "0") {
    return false;
  }
  return true;
}

export const ENABLE_HOST_ORGS = isHostOrgsEnabled();
