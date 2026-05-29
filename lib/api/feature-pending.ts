/**
 * #768 lockdown #23 — standard 501 response for stubbed v0 surfaces.
 *
 * Routes that return a "Coming Soon" indicator MUST use this helper
 * (consistency for the client renderer + the audit-log demand signal).
 */

import { NextResponse } from "next/server";

// Not-yet-built surfaces belong here. As of #775 the list is EMPTY — the last
// remaining stub (CHARGE_MEMBER instant overage charge) now ships end-to-end.
// SCIM, DPDP self-serve erasure, TDS + Form 26Q are shipped; HRIS was dropped;
// refund/credit-note flows are implicit (journal reversal / invoice VOID). The
// mechanism stays for future v-next stubs.
export const COMING_SOON_FEATURES = [] as const;

// `string` (not the empty-tuple union, which is `never`) so the helper +
// ComingSoonBadge stay callable when a future stub is added.
export type ComingSoonFeature = string;

/**
 * Standard 501 response. Renders consistently across surfaces and
 * carries a stable `code` for the client to switch on.
 *
 * Callers SHOULD also write an OrgAuditLog row with
 * `action: 'FEATURE_PENDING_REQUESTED'` and `details: { feature }` so
 * we can quantify demand without instrumenting per-surface analytics.
 */
export function respondFeaturePending(
  feature: ComingSoonFeature,
  message?: string,
): NextResponse {
  return NextResponse.json(
    {
      error: "FEATURE_PENDING",
      code: "FEATURE_PENDING",
      feature,
      message:
        message ??
        `This feature ships in v1.1. Track readiness via the in-app roadmap.`,
    },
    { status: 501 },
  );
}
