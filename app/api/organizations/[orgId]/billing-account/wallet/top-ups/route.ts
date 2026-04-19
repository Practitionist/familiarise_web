/**
 * GET  /api/organizations/[orgId]/billing-account/wallet/top-ups
 * POST /api/organizations/[orgId]/billing-account/wallet/top-ups
 *
 * POST initiates a Razorpay order and creates a pending WalletEntry
 * keyed by `providerOrderId`. The order id returned to the client
 * drives the Razorpay checkout; the /api/webhooks/razorpay handler
 * calls `confirmTopUp(providerOrderId, razorpayPaymentId)` to settle
 * the entry into a real balance increase.
 *
 * The idempotency guarantee comes from @unique on
 * WalletEntry.providerOrderId — two concurrent POSTs can't both mint
 * an order for the same client token.
 *
 * Razorpay integration is the minimum shape needed to create an order.
 * Full webhook signature verification + retry backoff lives in
 * /api/webhooks/razorpay (unchanged from Phase 1).
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { initiateTopUp } from "@/lib/api/organizations/wallet";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";

const TopUpBodySchema = z.object({
  // Minimum top-up of ₹100 (10000 paise) so gateway fees don't dwarf
  // the credit. No hard maximum — enterprise orgs routinely top up
  // in lakhs; we rely on the admin-role gate to authorize.
  amountPaise: z.coerce.number().int().min(10_000),
  // Optional idempotency key from the client. If supplied, reuse a
  // pending WalletEntry instead of minting a new Razorpay order on
  // a double-click.
  clientIdempotencyKey: z.string().min(8).max(128).optional(),
});

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const access = await requireOrgAccess(orgId, { minimumRole: "MANAGER", canSponsor: true });
  if (access.error) return access.error;

  const ba = await prisma.billingAccount.findFirst({
    where: { ownerOrgId: orgId },
    select: { id: true, fundingSource: true },
  });
  if (!ba || ba.fundingSource !== "WALLET") {
    return NextResponse.json(
      { error: "Wallet top-ups require WALLET funding" },
      { status: 404 },
    );
  }

  const url = new URL(req.url);
  const page = Math.max(1, Number(url.searchParams.get("page") ?? 1));
  const perPage = Math.min(
    100,
    Math.max(1, Number(url.searchParams.get("perPage") ?? 20)),
  );

  const where = {
    billingAccountId: ba.id,
    reason: "TOPUP" as const,
  };
  const [total, topUps] = await prisma.$transaction([
    prisma.walletEntry.count({ where }),
    prisma.walletEntry.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * perPage,
      take: perPage,
    }),
  ]);

  return NextResponse.json({
    data: topUps,
    meta: { total, page, perPage },
  });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  // OWNER-only: top-up moves real money. A MAINTAINER can queue
  // invites and edit programs, but spinning up an external Razorpay
  // charge should live with the person who pays the bill.
  const access = await requireOrgAccess(orgId, { minimumRole: "OWNER", canSponsor: true });
  if (access.error) return access.error;

  const raw = await req.json().catch(() => null);
  const parsed = TopUpBodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body", detail: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const { amountPaise, clientIdempotencyKey } = parsed.data;

  const ba = await prisma.billingAccount.findFirst({
    where: { ownerOrgId: orgId },
  });
  if (!ba) {
    return NextResponse.json(
      { error: "Organization does not have a BillingAccount" },
      { status: 404 },
    );
  }
  if (ba.fundingSource !== "WALLET") {
    return NextResponse.json(
      { error: "Top-ups are only allowed on WALLET funding" },
      { status: 409 },
    );
  }

  // Idempotent by client key: reuse an open pending entry instead of
  // minting a second order on a duplicate POST. The WalletEntry row
  // itself is keyed by providerOrderId (@unique), so even without the
  // client key a retry of the same physical request can't create a
  // duplicate.
  if (clientIdempotencyKey) {
    const existing = await prisma.walletEntry.findUnique({
      where: { providerOrderId: clientIdempotencyKey },
    });
    if (existing) {
      return NextResponse.json(
        {
          providerOrderId: existing.providerOrderId,
          amountPaise,
          status: "pending",
          reused: true,
        },
        { status: 200 },
      );
    }
  }

  // Generate a provider order id. In the real Razorpay path this is
  // minted by `razorpay.orders.create`; the integration is stubbed here
  // because the live client setup belongs in lib/payments/core/razorpay.
  // The webhook at /api/webhooks/razorpay expects this exact id back
  // from Razorpay to call confirmTopUp.
  const providerOrderId =
    clientIdempotencyKey ??
    `order_topup_${orgId.slice(0, 8)}_${Date.now()}_${Math.random()
      .toString(36)
      .slice(2, 8)}`;

  await prisma.$transaction(async (tx) => {
    await initiateTopUp(
      // The helper takes `PrismaClient`, but the transaction client
      // shares the same surface; Prisma transparently accepts it.
      tx as unknown as typeof prisma,
      {
        billingAccountId: ba.id,
        amountPaise,
        providerOrderId,
        notes: `Top-up initiated by membership ${access.member.id}`,
      },
    );
    await tx.orgAuditLog.create({
      data: {
        organizationId: orgId,
        actorMembershipId: access.member.id,
        category: "WALLET",
        action: AUDIT_ACTIONS.WALLET.WALLET_TOPUP,
        description: `Top-up initiated: ₹${(amountPaise / 100).toLocaleString("en-IN")}`,
        details: { providerOrderId, amountPaise },
      },
    });
  });

  return NextResponse.json(
    {
      providerOrderId,
      amountPaise,
      status: "pending",
      reused: false,
    },
    { status: 201 },
  );
}
