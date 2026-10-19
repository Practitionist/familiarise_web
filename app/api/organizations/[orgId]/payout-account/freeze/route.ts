/**
 * GET /api/organizations/[orgId]/payout-account/freeze — the "this wasn't me"
 * link in the payout-account change email. Mint refuses a frozen account and
 * only an admin lifts the freeze.
 */

import { NextResponse, type NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";
import { getAppUrl } from "@/lib/url";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const access = await requireOrgAccess(orgId, {
    permission: "payouts.account.manage",
  });
  if (access.error) return access.error;

  await prisma.$transaction(async (tx) => {
    const frozen = await tx.organizationPayoutAccount.updateMany({
      where: { organizationId: orgId, payoutsFrozenAt: null },
      data: { payoutsFrozenAt: new Date() },
    });
    if (frozen.count === 0) return;
    await tx.orgAuditLog.create({
      data: {
        organizationId: orgId,
        actorMembershipId: access.member.id,
        category: "PAYOUT",
        action: AUDIT_ACTIONS.PAYOUT.PAYOUT_ACCOUNT_UPDATED,
        description: "Payouts frozen from the payout-account change email",
        details: { payoutsFrozen: true },
      },
    });
  });

  return NextResponse.redirect(
    `${getAppUrl()}/dashboard/organization/${encodeURIComponent(orgId)}/payouts?payouts=frozen`,
  );
}
