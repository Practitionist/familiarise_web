/**
 * Org payouts (PROVIDER feature).
 *
 * GET / POST — gated behind ENABLE_PROVIDER_ORGS. Returns 501 with the flag
 * name when disabled. When the flag is flipped on, the handlers below will be
 * fleshed out to query OrganizationPayout / OrganizationEarnings and create
 * batch payouts via the same payout pipeline used by ConsultantPayouts.
 *
 * See Issue #646 for the deferred PROVIDER work.
 */

import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { ENABLE_PROVIDER_ORGS } from "@/lib/feature-flags";

function notImplemented() {
  return NextResponse.json(
    {
      error:
        "PROVIDER organization payouts are not yet available.",
      flag: "ENABLE_PROVIDER_ORGS",
    },
    { status: 501 },
  );
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  if (!ENABLE_PROVIDER_ORGS) return notImplemented();

  const { orgId } = await params;
  const access = await requireOrgAccess(orgId, "ORG_MANAGER");
  if (access.error) return access.error;

  if (access.org.kind === "BUYER") {
    return NextResponse.json(
      { error: "BUYER orgs do not have payouts." },
      { status: 400 },
    );
  }

  const payouts = await prisma.organizationPayout.findMany({
    where: { organizationProfileId: access.org.id },
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json({ payouts });
}

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  if (!ENABLE_PROVIDER_ORGS) return notImplemented();

  const { orgId } = await params;
  const access = await requireOrgAccess(orgId, "ORG_OWNER");
  if (access.error) return access.error;

  if (access.org.kind === "BUYER") {
    return NextResponse.json(
      { error: "BUYER orgs do not have payouts." },
      { status: 400 },
    );
  }

  try {
    const {
      getOrgPayoutEligibility,
      createOrgPayoutBatch,
    } = await import("@/lib/payments/payouts/org-payout-service");

    // Pre-check eligibility
    const eligibility = await getOrgPayoutEligibility(access.org.id);
    if (!eligibility.eligible) {
      return NextResponse.json(
        { error: eligibility.reason },
        { status: 400 },
      );
    }

    const result = await createOrgPayoutBatch(access.org.id);
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to create payout batch.";
    const status = message.includes("try again") ? 409 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
