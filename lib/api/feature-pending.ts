/**
 * #768 lockdown #23 — standard 501 response for stubbed v0 surfaces.
 *
 * Routes that return a "Coming Soon" indicator MUST use this helper
 * (consistency for the client renderer + the audit-log demand signal).
 */

import { NextResponse } from "next/server";

// #777 — `string` so the helper stays callable when a future stub is added.
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
