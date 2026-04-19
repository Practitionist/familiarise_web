/**
 * GET /api/organizations/[orgId]/billing-account/wallet
 *
 * Read-only wallet snapshot: current balance + paginated ledger. Only
 * returns data when the BillingAccount is in WALLET funding mode — for
 * INVOICE or LICENSE orgs the wallet isn't meaningful, so callers get
 * a 404 rather than a zero-balance ghost response.
 *
 * Top-ups go through the sibling /top-ups route. Refunds come from the
 * /api/payments/refunds webhook path and end up as WalletEntry rows
 * with reason=REFUND.
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";

const LedgerQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(50),
});

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const access = await requireOrgAccess(orgId, "MANAGER");
  if (access.error) return access.error;

  const ba = await prisma.billingAccount.findFirst({
    where: { ownerOrgId: orgId },
    select: {
      id: true,
      fundingSource: true,
      currency: true,
      walletBalance: true,
    },
  });
  if (!ba) {
    return NextResponse.json(
      { error: "Organization does not have a BillingAccount" },
      { status: 404 },
    );
  }
  if (ba.fundingSource !== "WALLET") {
    return NextResponse.json(
      {
        error: "Wallet is only available for WALLET-funded accounts",
        currentFundingSource: ba.fundingSource,
      },
      { status: 409 },
    );
  }

  const url = new URL(req.url);
  const parsed = LedgerQuerySchema.safeParse(
    Object.fromEntries(url.searchParams.entries()),
  );
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid pagination", detail: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const { page, perPage } = parsed.data;

  const [total, ledger] = await prisma.$transaction([
    prisma.walletEntry.count({ where: { billingAccountId: ba.id } }),
    prisma.walletEntry.findMany({
      where: { billingAccountId: ba.id },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * perPage,
      take: perPage,
    }),
  ]);

  return NextResponse.json({
    billingAccount: {
      id: ba.id,
      currency: ba.currency,
      walletBalance: ba.walletBalance ?? 0,
    },
    ledger,
    meta: { total, page, perPage },
  });
}
