/**
 * GET /api/organizations/[orgId]/billing-account/wallet/top-ups/[topUpId]
 *
 * Fetch a single top-up WalletEntry by its providerOrderId. Used by the
 * client post-checkout to poll for "did the webhook confirm my top-up
 * yet?" without exposing the whole ledger.
 */

import { NextResponse, type NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";

export async function GET(
  _req: NextRequest,
  {
    params,
  }: {
    params: Promise<{ orgId: string; topUpId: string }>;
  },
) {
  const { orgId, topUpId } = await params;
  const access = await requireOrgAccess(orgId, "MANAGER");
  if (access.error) return access.error;

  // topUpId is the providerOrderId; scope by billing account ownership
  // so a stolen order id from another tenant doesn't leak state.
  const entry = await prisma.walletEntry.findFirst({
    where: {
      providerOrderId: topUpId,
      billingAccount: { ownerOrgId: orgId },
    },
  });
  if (!entry) {
    return NextResponse.json({ error: "Top-up not found" }, { status: 404 });
  }

  // deltaPaise=0 means the webhook hasn't confirmed yet (pending
  // placeholder from initiateTopUp). A non-zero delta means the
  // balance was credited — callers use this to flip UI state.
  const status = entry.deltaPaise === 0 ? "pending" : "confirmed";
  return NextResponse.json({
    topUp: {
      providerOrderId: entry.providerOrderId,
      providerPaymentId: entry.providerPaymentId,
      status,
      amountPaise: entry.deltaPaise,
      balanceAfter: entry.balanceAfter,
      createdAt: entry.createdAt,
    },
  });
}
