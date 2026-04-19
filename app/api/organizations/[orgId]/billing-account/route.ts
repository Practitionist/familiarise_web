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
 * INVOICE→accrual, LICENSE→no charge). Only OWNERs can change it, and
 * we only allow the change when there are no outstanding invoices or
 * non-zero wallet balance that would be orphaned.
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { requireOrgAccess, requireOrgOwner } from "@/lib/auth-helpers";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";

// PROJECT is reserved in the Prisma enum for v2 project-billing; the
// API layer rejects it so callers can't quietly land a BillingAccount
// shape checkout can't honour. See note in app/api/organizations/route.ts.
const FundingSourceSchema = z.enum([
  "PERSONAL",
  "LICENSE",
  "WALLET",
  "INVOICE",
]);

const CurrencySchema = z.enum(["INR", "USD", "EUR", "GBP"]);

const PatchBodySchema = z
  .object({
    billingEmail: z.string().email().optional(),
    currency: CurrencySchema.optional(),
    fundingSource: FundingSourceSchema.optional(),
    creditLimit: z.coerce.number().int().min(0).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: "PATCH body must contain at least one field",
  });

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const access = await requireOrgAccess(orgId, "MANAGER");
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
              walletLedger: true,
            },
          },
        },
      },
    },
  });
  if (!org?.billingAccount) {
    return NextResponse.json(
      { error: "Organization does not have a BillingAccount (canSponsor=false)" },
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
  const access = await requireOrgOwner(orgId);
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

      // Funding-source change guards. We only refuse the change when
      // moving away from WALLET with a non-zero balance or away from
      // INVOICE with outstanding invoices — either would orphan money
      // in the old mode. The reverse transitions (INTO WALLET/INVOICE)
      // are always fine because we're starting fresh in the new mode.
      if (
        body.fundingSource &&
        body.fundingSource !== ba.fundingSource
      ) {
        if (
          ba.fundingSource === "WALLET" &&
          (ba.walletBalance ?? 0) > 0
        ) {
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
              body.fundingSource === "WALLET"
                ? ba.walletBalance ?? 0
                : null,
          }),
          ...(body.creditLimit !== undefined && {
            creditLimit: body.creditLimit,
          }),
        },
      });

      await tx.orgAuditLog.create({
        data: {
          organizationId: orgId,
          actorMembershipId: access.member.id,
          category: "SETTINGS",
          action: AUDIT_ACTIONS.SETTINGS.SETTINGS_CHANGED,
          description: "BillingAccount updated",
          details: {
            from: {
              fundingSource: ba.fundingSource,
              currency: ba.currency,
              creditLimit: ba.creditLimit,
            },
            to: {
              fundingSource: next.fundingSource,
              currency: next.currency,
              creditLimit: next.creditLimit,
            },
          },
        },
      });

      return next;
    });

    return NextResponse.json({ billingAccount: updated });
  } catch (err) {
    if (err instanceof Error && "httpStatus" in err) {
      const status =
        typeof err.httpStatus === "number" ? err.httpStatus : 500;
      return NextResponse.json({ error: err.message }, { status });
    }
    throw err;
  }
}
