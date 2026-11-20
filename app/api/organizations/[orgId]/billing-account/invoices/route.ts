/**
 * GET /api/organizations/[orgId]/billing-account/invoices
 *
 * The org's invoice register. Only the platform raises an invoice, through
 * POST /api/admin/organizations/[orgId]/invoices or the billing crons. Drafts
 * are listed only for a role that manages billing.
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { visibleInvoiceWhere } from "@/lib/enterprise/invoice-visibility";
import { outstandingPaiseByInvoice } from "@/lib/payments/billing/org-invoice-settlement";

const InvoiceStatusSchema = z.enum([
  "DRAFT",
  "ISSUED",
  "PAID",
  "OVERDUE",
  "VOID",
  "CANCELLED",
]);

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const access = await requireOrgAccess(orgId, {
    readOnly: true,
    permission: "billing.read",
    canSponsor: true,
  });
  if (access.error) return access.error;

  const url = new URL(req.url);
  const rawStatus = url.searchParams.get("status");
  const status = rawStatus ? InvoiceStatusSchema.safeParse(rawStatus) : null;
  const page = Math.max(1, Number(url.searchParams.get("page") ?? 1));
  const perPage = Math.min(
    100,
    Math.max(1, Number(url.searchParams.get("perPage") ?? 20)),
  );

  // AND keeps a ?status=DRAFT request from overriding the draft filter.
  const where = {
    organizationId: orgId,
    AND: [
      visibleInvoiceWhere(access.member.role),
      status?.success ? { status: status.data } : {},
    ],
  };

  const [total, invoices] = await prisma.$transaction([
    prisma.organizationInvoice.count({ where }),
    prisma.organizationInvoice.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * perPage,
      take: perPage,
      include: {
        purchaseOrder: { select: { id: true, poNumber: true } },
      },
    }),
  ]);

  const outstanding = await outstandingPaiseByInvoice(prisma, invoices);
  return NextResponse.json({
    data: invoices.map((inv) => ({
      ...inv,
      outstandingPaise: outstanding.get(inv.id) ?? 0,
    })),
    meta: { total, page, perPage },
  });
}
