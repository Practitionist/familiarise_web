/**
 * GET   /api/organizations/[orgId]/billing-account
 * PATCH /api/organizations/[orgId]/billing-account
 *
 * One BillingAccount per sponsoring org. This endpoint manages the
 * top-level account record — funding source, billing email, credit
 * limit. The wallet ledger lives under /wallet, invoices under
 * /invoices, purchase orders under /purchase-orders.
 *
 * A funding-source change is a serious lifecycle event — it switches
 * which downstream flow runs at checkout (WALLET→wallet debit,
 * INVOICE→accrual, LICENSE→no charge). `billing.fundingSource.switch`
 * (OWNER, BILLING_ADMIN — #1851 decision 7) changes it, each switch writes
 * its own audit row, and we only allow the change when there are no
 * outstanding invoices or non-zero wallet balance that would be orphaned.
 */

import * as Sentry from "@sentry/nextjs";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { hasOrgPermission } from "@/lib/auth/org-permissions";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";
import { assertVerifiedDomainOrThrow } from "@/lib/enterprise/governance";

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

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const access = await requireOrgAccess(orgId, {
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
              invoices: true,
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

      // Funding-source change guards. We only refuse the change when
      // moving away from WALLET with a non-zero balance or away from
      // INVOICE with outstanding invoices — either would orphan money
      // in the old mode. The reverse transitions (INTO WALLET/INVOICE)
      // are always fine because we're starting fresh in the new mode.
      if (body.fundingSource && body.fundingSource !== ba.fundingSource) {
        if (ba.fundingSource === "WALLET" && (ba.walletBalance ?? 0) > 0) {
          throw Object.assign(
            new Error(
              "Cannot switch funding source with a non-zero wallet balance. Drain or refund the wallet first.",
            ),
            { httpStatus: 409 },
          );
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
                `Cannot switch funding source with ${outstanding} outstanding invoice(s). Settle or void them first.`,
              ),
              { httpStatus: 409 },
            );
          }
        }
        // K-02 / #687 — enabling INVOICE funding requires a verified domain
        // (governance.ts documents this gate for the fundingSource→INVOICE
        // transition). tx-scoped read: TOCTOU-safe against a concurrent
        // verification rollback.
        if (body.fundingSource === "INVOICE") {
          await assertVerifiedDomainOrThrow(tx, orgId, "INVOICE_FUNDING");
        }
      }

      const next = await tx.billingAccount.update({
        where: { id: ba.id },
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

      // #1851 decision 7 — a money category, so the finance audit readers
      // see it and the operations-only readers never see a credit limit.
      if (next.fundingSource !== ba.fundingSource) {
        await tx.orgAuditLog.create({
          data: {
            organizationId: orgId,
            actorMembershipId: access.member.id,
            category: "INVOICE",
            action: AUDIT_ACTIONS.INVOICE.FUNDING_SOURCE_CHANGED,
            description: `Funding source: ${ba.fundingSource} → ${next.fundingSource}`,
            details: { from: ba.fundingSource, to: next.fundingSource },
          },
        });
      }
      await tx.orgAuditLog.create({
        data: {
          organizationId: orgId,
          actorMembershipId: access.member.id,
          category: "INVOICE",
          action: AUDIT_ACTIONS.INVOICE.BILLING_ACCOUNT_UPDATED,
          description: "BillingAccount updated",
          details: {
            from: {
              fundingSource: ba.fundingSource,
              currency: ba.currency,
              creditLimit: ba.creditLimit,
              minBalancePaise: ba.minBalancePaise,
            },
            to: {
              fundingSource: next.fundingSource,
              currency: next.currency,
              creditLimit: next.creditLimit,
              minBalancePaise: next.minBalancePaise,
            },
          },
        },
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
