/**
 * GET  /api/organizations/[orgId]/billing-account/purchase-orders
 * POST /api/organizations/[orgId]/billing-account/purchase-orders
 *
 * First-class PurchaseOrder surface for India AP 3-way-match workflows
 * (Org.requiresPO=true forces every Contract and Invoice to reference a
 * live PO). Orgs without `requiresPO=true` can still create POs for
 * tracking, but the 3-way match isn't enforced.
 *
 * PO numbers are caller-provided (`poNumber`) because enterprise
 * finance teams issue them from their own AP systems and expect the
 * same number to appear on the invoice. We enforce uniqueness per org.
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { requireOrgAccess, requireOrgOwner } from "@/lib/auth-helpers";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";

const CurrencySchema = z.enum(["INR", "USD", "EUR", "GBP"]);
const PoStatusSchema = z.enum(["ACTIVE", "CLOSED", "CANCELLED"]);

const CreateBodySchema = z.object({
  poNumber: z.string().min(1).max(64),
  poDate: z.coerce.date(),
  validUntil: z.coerce.date().nullable().optional(),
  totalAmountPaise: z.coerce.number().int().min(0),
  currency: CurrencySchema.default("INR"),
  uploadedDocUrl: z.string().url().nullable().optional(),
});

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const access = await requireOrgAccess(orgId, "MANAGER");
  if (access.error) return access.error;

  const url = new URL(req.url);
  const rawStatus = url.searchParams.get("status");
  const status = rawStatus ? PoStatusSchema.safeParse(rawStatus) : null;

  const purchaseOrders = await prisma.purchaseOrder.findMany({
    where: {
      organizationId: orgId,
      ...(status?.success ? { status: status.data } : {}),
    },
    orderBy: { createdAt: "desc" },
    include: {
      _count: {
        select: { invoices: true, contracts: true },
      },
    },
  });

  return NextResponse.json({ data: purchaseOrders });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const access = await requireOrgOwner(orgId);
  if (access.error) return access.error;

  const raw = await req.json().catch(() => null);
  const parsed = CreateBodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body", detail: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const body = parsed.data;

  try {
    const po = await prisma.$transaction(async (tx) => {
      // (organizationId, poNumber) is unique per schema; catch the
      // duplicate early so we return a readable 409 instead of
      // bubbling up a P2002 as a 500.
      const existing = await tx.purchaseOrder.findFirst({
        where: { organizationId: orgId, poNumber: body.poNumber },
        select: { id: true },
      });
      if (existing) {
        throw Object.assign(
          new Error(`PO number ${body.poNumber} already exists for this org`),
          { httpStatus: 409 },
        );
      }

      const created = await tx.purchaseOrder.create({
        data: {
          organizationId: orgId,
          poNumber: body.poNumber,
          poDate: body.poDate,
          validUntil: body.validUntil ?? null,
          totalAmountPaise: body.totalAmountPaise,
          // remainingAmountPaise mirrors totalAmountPaise at creation.
          // Invoice issuance doesn't auto-decrement today — we leave
          // that to a follow-up reconciliation pass so the 3-way match
          // can be done strictly or leniently per org policy.
          remainingAmountPaise: body.totalAmountPaise,
          currency: body.currency,
          uploadedDocUrl: body.uploadedDocUrl ?? null,
          status: "ACTIVE",
        },
      });

      await tx.orgAuditLog.create({
        data: {
          organizationId: orgId,
          actorMembershipId: access.member.id,
          category: "INVOICE",
          action: AUDIT_ACTIONS.INVOICE.PURCHASE_ORDER_CREATED,
          description: `PO ${body.poNumber} created (${body.currency} ${(
            body.totalAmountPaise / 100
          ).toLocaleString()})`,
          details: {
            purchaseOrderId: created.id,
            poNumber: body.poNumber,
            totalAmountPaise: body.totalAmountPaise,
          },
        },
      });

      return created;
    });

    return NextResponse.json({ purchaseOrder: po }, { status: 201 });
  } catch (err) {
    if (err instanceof Error && "httpStatus" in err) {
      const status =
        typeof err.httpStatus === "number" ? err.httpStatus : 500;
      return NextResponse.json({ error: err.message }, { status });
    }
    throw err;
  }
}
