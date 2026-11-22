/**
 * GET   /api/organizations/[orgId]/billing-account
 * PATCH /api/organizations/[orgId]/billing-account
 *
 * One BillingAccount per sponsoring org. This endpoint manages the
 * top-level account record — funding source, billing email, credit
 * limit. The wallet ledger lives under /wallet, invoices under
 * /invoices, purchase orders under /purchase-orders.
 *
 * A funding-source change switches which flow runs at checkout
 * (WALLET→wallet debit, INVOICE→accrual, LICENSE→no charge). It needs
 * `billing.fundingSource.switch`, writes its own audit row, and is refused
 * while a wallet balance, a wallet shortfall, an unpaid member overage on a
 * wallet-funded booking, or outstanding invoices would be orphaned.
 *
 * Only the platform extends credit: a tenant may lower its credit limit but
 * not raise or remove it, nor switch to INVOICE funding. Ops do both through
 * PATCH /api/admin/organizations/[orgId]/billing-account.
 */

import * as Sentry from "@sentry/nextjs";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { hasOrgPermission } from "@/lib/auth/org-permissions";
import { assertWalletFundingSwitchable } from "@/lib/api/organizations/wallet";
import { recordBillingAccountUpdate } from "@/lib/enterprise/billing-account-audit";
import { visibleInvoiceWhere } from "@/lib/enterprise/invoice-visibility";

// PROJECT is reserved in the Prisma enum for v2 project-billing; the
// API layer rejects it so callers can't quietly land a BillingAccount
// shape checkout can't honour. See note in app/api/organizations/route.ts.
const FundingSourceSchema = z.enum([
  "PERSONAL",
  "LICENSE",
  "WALLET",
  "INVOICE",
]);

// INR only: wallet top-ups forward `BillingAccount.currency` verbatim into
// `createRazorpayOrder`, and every stored amount is INR paise.
const CurrencySchema = z.literal("INR");

// Wallet minimum balance is a notify-only floor (the cron emails finance below it).
const PatchBodySchema = z
  .object({
    billingEmail: z.string().email().optional(),
    currency: CurrencySchema.optional(),
    fundingSource: FundingSourceSchema.optional(),
    creditLimit: z.coerce.number().int().min(0).nullable().optional(),
    minBalancePaise: z.coerce.number().int().min(0).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: "PATCH body must contain at least one field",
  });

/** Unlimited (null) counts as the highest limit, so any finite limit lowers it. */
function isCreditLimitLowering(
  current: number | null,
  next: number | null,
): boolean {
  return next !== null && (current === null || next <= current);
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const access = await requireOrgAccess(orgId, {
    readOnly: true,
    permission: "billing.read",
    canSponsor: true,
  });
  if (access.error) return access.error;

  const org = await prisma.organization.findUnique({
    where: { id: orgId },
    select: {
      billingAccount: {
        include: {
          subscription: true,
          _count: {
            select: {
              invoices: { where: visibleInvoiceWhere(access.member.role) },
              contracts: true,
              walletTopUps: true,
            },
          },
        },
      },
    },
  });
  if (!org?.billingAccount) {
    return NextResponse.json(
      {
        error: "Organization does not have a BillingAccount (canSponsor=false)",
      },
      { status: 404 },
    );
  }
  return NextResponse.json({ billingAccount: org.billingAccount });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const access = await requireOrgAccess(orgId, {
    permission: "billing.manage",
    canSponsor: true,
    requireActive: true,
  });
  if (access.error) return access.error;

  const raw = await req.json().catch(() => null);
  const parsed = PatchBodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body", detail: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const body = parsed.data;
  if (
    body.fundingSource !== undefined &&
    !hasOrgPermission(access.member.role, "billing.fundingSource.switch")
  ) {
    return NextResponse.json(
      { error: "Your role cannot switch the funding source." },
      { status: 403 },
    );
  }

  try {
    const updated = await prisma.$transaction(async (tx) => {
      const ba = await tx.billingAccount.findFirst({
        where: { ownerOrgId: orgId },
      });
      if (!ba) {
        throw Object.assign(
          new Error(
            "Organization does not have a BillingAccount. Enable canSponsor first.",
          ),
          { httpStatus: 404 },
        );
      }

      if (
        body.creditLimit !== undefined &&
        !isCreditLimitLowering(ba.creditLimit, body.creditLimit)
      ) {
        throw Object.assign(
          new Error(
            "Only Familiarise can raise or remove a credit limit. Contact Familiarise support to change this.",
          ),
          { httpStatus: 403, code: "CREDIT_LIMIT_PLATFORM_ONLY" },
        );
      }
      if (body.fundingSource === "INVOICE" && ba.fundingSource !== "INVOICE") {
        throw Object.assign(
          new Error(
            "Only Familiarise can switch an organization to invoice funding. Contact Familiarise support to change this.",
          ),
          { httpStatus: 403, code: "INVOICE_FUNDING_PLATFORM_ONLY" },
        );
      }

      // The balance alert applies only to WALLET funding: the incoming
      // funding source if being changed, else the stored one.
      if (body.minBalancePaise !== undefined) {
        const effectiveFunding = body.fundingSource ?? ba.fundingSource;
        if (effectiveFunding !== "WALLET") {
          throw Object.assign(
            new Error("Balance alerts only apply to WALLET-funded accounts."),
            { httpStatus: 400, code: "WALLET_ONLY" },
          );
        }
      }

      // Moving away from WALLET with a balance, or away from INVOICE with
      // outstanding invoices, would orphan money in the old mode.
      if (body.fundingSource && body.fundingSource !== ba.fundingSource) {
        if (ba.fundingSource === "WALLET" && (ba.walletBalance ?? 0) > 0) {
          throw Object.assign(
            new Error(
              "Cannot switch funding source with a non-zero wallet balance. Drain or refund the wallet first.",
            ),
            { httpStatus: 409 },
          );
        }
        if (ba.fundingSource === "WALLET") {
          await assertWalletFundingSwitchable(tx, ba.id);
        }
        if (ba.fundingSource === "INVOICE") {
          const outstanding = await tx.organizationInvoice.count({
            where: {
              billingAccountId: ba.id,
              status: { in: ["ISSUED", "OVERDUE"] },
            },
          });
          if (outstanding > 0) {
            throw Object.assign(
              new Error(
                `Cannot switch funding source with ${outstanding} outstanding invoice(s). Settle them first.`,
              ),
              { httpStatus: 409 },
            );
          }
        }
      }

      // CAS on the values the checks above read: a concurrent platform limit
      // change or wallet credit refuses this write instead of being overwritten.
      const cas = await tx.billingAccount.updateMany({
        where: {
          id: ba.id,
          ...(body.creditLimit !== undefined && {
            creditLimit: ba.creditLimit,
          }),
          ...(body.fundingSource !== undefined && {
            fundingSource: ba.fundingSource,
            walletBalance: ba.walletBalance,
          }),
        },
        data: {
          ...(body.billingEmail !== undefined && {
            billingEmail: body.billingEmail,
          }),
          ...(body.currency !== undefined && { currency: body.currency }),
          ...(body.fundingSource !== undefined && {
            fundingSource: body.fundingSource,
            // Initialize walletBalance when moving TO wallet, clear
            // when moving AWAY. Keeps the column NULL for non-wallet
            // accounts so callers can't accidentally read it.
            walletBalance:
              body.fundingSource === "WALLET" ? (ba.walletBalance ?? 0) : null,
          }),
          ...(body.creditLimit !== undefined && {
            creditLimit: body.creditLimit,
          }),
          ...(body.minBalancePaise !== undefined && {
            minBalancePaise: body.minBalancePaise,
          }),
        },
      });
      if (cas.count !== 1) {
        throw Object.assign(
          new Error("Billing account changed concurrently. Reload and retry."),
          { httpStatus: 409, code: "BILLING_ACCOUNT_CONFLICT" },
        );
      }
      const next = await tx.billingAccount.findUniqueOrThrow({
        where: { id: ba.id },
      });

      await recordBillingAccountUpdate(tx, {
        organizationId: orgId,
        actorMembershipId: access.member.id,
        before: ba,
        after: next,
      });

      return next;
    });

    return NextResponse.json({ billingAccount: updated });
  } catch (err) {
    if (err instanceof Error && "httpStatus" in err) {
      const status = typeof err.httpStatus === "number" ? err.httpStatus : 500;
      const code =
        "code" in err && typeof err.code === "string" ? err.code : undefined;
      return NextResponse.json(
        { error: err.message, ...(code && { code }) },
        { status },
      );
    }
    Sentry.captureException(
      err instanceof Error ? err : new Error(String(err)),
      { tags: { subsystem: "enterprise" } },
    );
    throw err;
  }
}
