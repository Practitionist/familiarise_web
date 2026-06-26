/**
 * GET /api/organizations/[orgId]/payout-account
 * PUT /api/organizations/[orgId]/payout-account
 *
 * Hosting-side bank/payout credentials (canHost=true orgs). The record is
 * 1:1 with Organization — a PUT either creates or updates. Full account
 * numbers are encrypted before storage; the public-readable last-four and
 * status flow is what UI surfaces render.
 *
 * Verification lifecycle (`status`) moves PENDING_VERIFICATION → VERIFIED
 * through a side-channel (Razorpay contact + fund-account creation). This
 * endpoint only writes the raw record; the verification job flips status.
 */

import * as Sentry from "@sentry/nextjs";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { requireOrgAccess, requireOrgOwner } from "@/lib/auth-helpers";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";
import { encodeAccountEnvelope } from "@/lib/payments/payouts/account-crypto";

const UpsertBodySchema = z.object({
  accountHolderName: z.string().min(1).max(200),
  // Full account number — stored encrypted. Last-four is derived.
  accountNumber: z.string().min(4).max(34),
  bankName: z.string().min(1).max(120),
  ifscCode: z.string().length(11).optional(),
  routingNumber: z.string().min(1).max(20).nullable().optional(),
  swiftCode: z.string().min(8).max(11).nullable().optional(),
});

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const access = await requireOrgAccess(orgId, "MANAGER");
  if (access.error) return access.error;

  if (!access.org.canHost) {
    return NextResponse.json(
      { error: "Organization does not host (canHost=false)" },
      { status: 404 },
    );
  }

  const payoutAccount = await prisma.organizationPayoutAccount.findUnique({
    where: { organizationId: orgId },
    select: {
      id: true,
      accountHolderName: true,
      accountNumberLast4: true,
      bankName: true,
      ifscCode: true,
      routingNumber: true,
      swiftCode: true,
      stripeConnectId: true,
      razorpayContactId: true,
      razorpayFundAccountId: true,
      status: true,
      verifiedAt: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  if (!payoutAccount) {
    return NextResponse.json(
      { payoutAccount: null, exists: false },
      { status: 200 },
    );
  }
  return NextResponse.json({ payoutAccount, exists: true });
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const access = await requireOrgOwner(orgId);
  if (access.error) return access.error;

  if (!access.org.canHost) {
    return NextResponse.json(
      {
        error: "Organization does not host. Enable canHost before setting a payout account.",
      },
      { status: 409 },
    );
  }

  const raw = await req.json().catch(() => null);
  const parsed = UpsertBodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body", detail: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const body = parsed.data;

  const last4 = body.accountNumber.slice(-4);
  let encrypted: string;
  try {
    encrypted = encodeAccountEnvelope(body.accountNumber);
  } catch (err) {
    Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { tags: { subsystem: "organizations" } });
    return NextResponse.json(
      {
        error: "Payout encryption is not configured on this server",
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }

  const upserted = await prisma.$transaction(async (tx) => {
    const existing = await tx.organizationPayoutAccount.findUnique({
      where: { organizationId: orgId },
    });

    // Changing bank details resets verification. A different account
    // number means the side-channel verification artifacts no longer
    // correspond to this record.
    const next = await tx.organizationPayoutAccount.upsert({
      where: { organizationId: orgId },
      create: {
        organizationId: orgId,
        accountHolderName: body.accountHolderName,
        accountNumberEncrypted: encrypted,
        accountNumberLast4: last4,
        bankName: body.bankName,
        ifscCode: body.ifscCode ?? null,
        routingNumber: body.routingNumber ?? null,
        swiftCode: body.swiftCode ?? null,
        status: "PENDING_VERIFICATION",
      },
      update: {
        accountHolderName: body.accountHolderName,
        accountNumberEncrypted: encrypted,
        accountNumberLast4: last4,
        bankName: body.bankName,
        ifscCode: body.ifscCode ?? null,
        routingNumber: body.routingNumber ?? null,
        swiftCode: body.swiftCode ?? null,
        // Force re-verification on any account-number change.
        ...(existing?.accountNumberLast4 !== last4 && {
          status: "PENDING_VERIFICATION",
          verifiedAt: null,
          razorpayContactId: null,
          razorpayFundAccountId: null,
        }),
      },
    });

    await tx.orgAuditLog.create({
      data: {
        organizationId: orgId,
        actorMembershipId: access.member.id,
        category: "SETTINGS",
        action: AUDIT_ACTIONS.SETTINGS.SETTINGS_CHANGED,
        description: existing
          ? "Payout account updated"
          : "Payout account created",
        details: {
          accountLast4: last4,
          bankName: body.bankName,
          ifscCode: body.ifscCode ?? null,
          verificationReset: existing?.accountNumberLast4 !== last4,
        },
      },
    });

    return next;
  });

  return NextResponse.json(
    {
      payoutAccount: {
        id: upserted.id,
        accountHolderName: upserted.accountHolderName,
        accountNumberLast4: upserted.accountNumberLast4,
        bankName: upserted.bankName,
        ifscCode: upserted.ifscCode,
        routingNumber: upserted.routingNumber,
        swiftCode: upserted.swiftCode,
        status: upserted.status,
        verifiedAt: upserted.verifiedAt,
        createdAt: upserted.createdAt,
        updatedAt: upserted.updatedAt,
      },
    },
    { status: 200 },
  );
}
