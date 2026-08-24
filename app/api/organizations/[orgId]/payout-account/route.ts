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
import {
  getRazorpayPayoutsService,
  isRazorpayPayoutsConfigured,
} from "@/lib/payments/payouts/razorpay-payouts";
import { transitionOrgPayoutAccount } from "@/lib/enterprise/transitions";

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
        // CR #1234 r3.5 — each PUT revision gets a distinct version, or the
        // id+version CAS predicates below cannot tell revisions apart.
        version: { increment: 1 },
        // Force re-verification on any verification-relevant change (CR
        // #1234 r2 — holder name and IFSC identify the destination as much
        // as the last-4 does; comparing last4 alone let a same-last-4
        // different-bank edit keep a stale VERIFIED stamp).
        ...(existing &&
        (existing.accountNumberLast4 !== last4 ||
          existing.accountHolderName !== body.accountHolderName ||
          (existing.ifscCode ?? null) !== (body.ifscCode ?? null))
          ? {
              status: "PENDING_VERIFICATION" as const,
              verifiedAt: null,
              razorpayContactId: null,
              razorpayFundAccountId: null,
            }
          : {}),
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

  // #1230 — wire the dormant verification loop. The FSM and the payout
  // preflight both expect VERIFIED rows, but nothing ever left
  // PENDING_VERIFICATION. Create the RazorpayX contact/fund account from the
  // raw details now (they are still in scope; the stored row is ciphertext),
  // run the penny-drop, and verify through the guarded CAS on "valid". Async
  // ("created") or failed validations leave PENDING_VERIFICATION — re-saving
  // bank details or a future reverify action retries it.
  if (isRazorpayPayoutsConfigured() && body.ifscCode) {
    // CR #1234 r3.5 — a re-provisioning attempt must not leave the row
    // VERIFIED while its new fund account is still unproven: demote first
    // (VERIFIED→PENDING is a legal edge), then provision. If validation
    // succeeds below, the CAS flips it back; if it fails, the row sits
    // honestly at PENDING_VERIFICATION.
    if (upserted.status === "VERIFIED") {
      await prisma.$transaction(async (tx) => {
        await transitionOrgPayoutAccount(tx, {
          where: { id: upserted.id, version: upserted.version },
          to: "PENDING_VERIFICATION",
          data: { verifiedAt: null },
        });
      });
    }
    try {
      const svc = getRazorpayPayoutsService();
      const contact = await svc.createContact({
        name: body.accountHolderName,
        email: access.org.billingEmail ?? "",
        type: "vendor",
        referenceId: orgId,
      });
      const fund = await svc.createFundAccount({
        contactId: contact.id,
        accountType: "bank_account",
        bankAccount: {
          name: body.accountHolderName,
          ifsc: body.ifscCode,
          accountNumber: body.accountNumber,
        },
      });
      const validation = await svc.validateBankAccount(fund.id);

      // CR #1234 r2 — bind BOTH writes to the bank-detail revision this
      // request created. A second PUT (new details, bumped version) landing
      // while our Razorpay calls are in flight must never receive the first
      // request's fund-account ids or a VERIFIED stamp it did not earn.
      await prisma.organizationPayoutAccount.updateMany({
        where: { id: upserted.id, version: upserted.version },
        data: {
          razorpayContactId: contact.id,
          razorpayFundAccountId: fund.id,
        },
      });
      if (validation.accountStatus === "valid") {
        // CAS on id+version: refuses rows already flipped concurrently or
        // superseded by newer bank details.
        await prisma.$transaction(async (tx) => {
          await transitionOrgPayoutAccount(tx, {
            where: { id: upserted.id, version: upserted.version },
            to: "VERIFIED",
            data: { verifiedAt: new Date() },
            audit: {
              organizationId: orgId,
              actorMembershipId: access.member.id,
              category: "SETTINGS",
              action: AUDIT_ACTIONS.SETTINGS.SETTINGS_CHANGED,
              description: "Payout account verified via RazorpayX penny-drop",
              details: { fundAccountId: fund.id, last4: last4 },
            },
          });
        });
      }
    } catch (err) {
      // Non-fatal: bank-detail upsert succeeded; verification retries later.
      console.error("[org-payout-account] penny-drop error:", err);
    }
  }

  // CR #1234 r2 — respond with the POST-verification row: the transition
  // above may have flipped status/verifiedAt after `upserted` was read.
  const fresh = await prisma.organizationPayoutAccount.findUniqueOrThrow({
    where: { organizationId: orgId },
  });

  return NextResponse.json(
    {
      payoutAccount: {
        id: fresh.id,
        accountHolderName: fresh.accountHolderName,
        accountNumberLast4: fresh.accountNumberLast4,
        bankName: fresh.bankName,
        ifscCode: fresh.ifscCode,
        routingNumber: fresh.routingNumber,
        swiftCode: fresh.swiftCode,
        status: fresh.status,
        verifiedAt: fresh.verifiedAt,
        createdAt: fresh.createdAt,
        updatedAt: fresh.updatedAt,
      },
    },
    { status: 200 },
  );
}
