/**
 * #768 lockdown #23 — standard 501 response for stubbed v0 surfaces.
 *
 * Routes that return a "Coming Soon" indicator MUST use this helper
 * (consistency for the client renderer + the audit-log demand signal).
 */

import { NextResponse } from "next/server";

// Only not-yet-built surfaces belong here (#775/#715). SCIM, DPDP self-serve
// erasure, TDS + Form 26Q are shipped; HRIS was dropped; refund/credit-note
// flows are implicit (journal reversal / invoice VOID). Sole remainder:
// CHARGE_MEMBER instant overage charge (#775/#715).
export const COMING_SOON_FEATURES = ["overage_charging"] as const;

export type ComingSoonFeature = (typeof COMING_SOON_FEATURES)[number];

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
