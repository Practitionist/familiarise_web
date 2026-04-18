/**
 * @arch4-stub Pending Arch 4-Modified rewrite (Issue #681).
 *
 * The original implementation relied on OrganizationProfile /
 * OrganizationMemberProfile / OrgCreditPool — all removed. The new model
 * uses Organization / Membership / BillingAccount / WalletEntry / Program.
 *
 * This route is currently a 501 placeholder. See:
 *   docs/enterprise/phase-2-api-rewrite-checklist.md
 * for the per-route migration plan.
 *
 * File: app/api/organizations/[orgId]/sso/providers/route.ts
 */

import { NextResponse } from "next/server";

function notImplemented(method: string) {
  return NextResponse.json(
    {
      error: "Not implemented",
      detail: `${method} app/api/organizations/[orgId]/sso/providers/route.ts is awaiting Arch 4-Modified rewrite; see Issue #681.`,
    },
    { status: 501 },
  );
}

export async function GET() {
  return notImplemented("GET");
}

export async function POST() {
  return notImplemented("POST");
}
