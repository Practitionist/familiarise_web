/**
 * POST /api/organizations/[orgId]/payout-account/freeze — sent by the confirm
 * page the payout-account change email links to. Mint refuses a frozen account
 * and only an admin lifts the freeze.
 */

import { NextResponse, type NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { isSameOriginJsonRequest } from "@/lib/api/same-origin";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  if (!isSameOriginJsonRequest(req)) {
    return NextResponse.json(
      { error: "Cross-site request refused", code: "CROSS_SITE" },
      { status: 403 },
    );
  }
  const { orgId } = await params;
  const access = await requireOrgAccess(orgId, {
    permission: "payouts.account.manage",
  });
  if (access.error) return access.error;

  const accounts = await prisma.$transaction(async (tx) => {
    const frozen = await tx.organizationPayoutAccount.updateMany({
      where: { organizationId: orgId, payoutsFrozenAt: null },
      data: { payoutsFrozenAt: new Date() },
    });
    if (frozen.count > 0) {
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
    }
    return frozen.count;
  });

  return NextResponse.json({ frozen: true, accounts });
}
