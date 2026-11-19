/**
 * GET   /api/organizations/[orgId]/billing-account/invoices/[invoiceId]
 * PATCH /api/organizations/[orgId]/billing-account/invoices/[invoiceId]
 *
 * A draft reads as not found to a role that does not manage billing. A tenant
 * may only cancel a DRAFT. Issuing, voiding and due-date or PDF
 * edits are the platform's; PAID and OVERDUE are webhook- and cron-owned.
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { visibleInvoiceWhere } from "@/lib/enterprise/invoice-visibility";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";
import { transitionOrgInvoice } from "@/lib/enterprise/transitions";
import { ORG_INVOICE_STATUS_LABEL } from "@/lib/labels/org-labels";
import { invoiceOutstandingPaise } from "@/lib/payments/billing/org-invoice-settlement";

const PatchBodySchema = z.object({ status: z.literal("CANCELLED") }).strict();

export async function GET(
  _req: NextRequest,
  {
    params,
  }: {
    params: Promise<{ orgId: string; invoiceId: string }>;
  },
) {
  const { orgId, invoiceId } = await params;
  const access = await requireOrgAccess(orgId, {
    readOnly: true,
    permission: "billing.read",
    canSponsor: true,
  });
  if (access.error) return access.error;

  const invoice = await prisma.organizationInvoice.findFirst({
    where: {
      id: invoiceId,
      organizationId: orgId,
      ...visibleInvoiceWhere(access.member.role),
    },
    include: {
      purchaseOrder: true,
      contract: { select: { id: true, status: true } },
      billedPayments: {
        select: { id: true, amount: true, currency: true, createdAt: true },
      },
      payment: true,
      // #1527 / #1836 — the org Billing detail sheet lists lines and the
      // issued credit notes (DRAFTs are not legal documents yet).
      lineItems: {
        orderBy: { position: "asc" },
        select: {
          id: true,
          description: true,
          quantity: true,
          unitPricePaise: true,
          taxPaise: true,
        },
      },
      creditNotes: {
        where: { status: "ISSUED" },
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          creditNoteNumber: true,
          totalPaise: true,
          issuedAt: true,
          reason: true,
        },
      },
    },
  });
  if (!invoice) {
    return NextResponse.json({ error: "Invoice not found" }, { status: 404 });
  }
  const outstandingPaise = await invoiceOutstandingPaise(prisma, invoice.id);
  return NextResponse.json({ invoice: { ...invoice, outstandingPaise } });
}

export async function PATCH(
  req: NextRequest,
  {
    params,
  }: {
    params: Promise<{ orgId: string; invoiceId: string }>;
  },
) {
  const { orgId, invoiceId } = await params;
  const access = await requireOrgAccess(orgId, {
    permission: "billing.manage",
    canSponsor: true,
    requireActive: true,
  });
  if (access.error) return access.error;

  const raw = await req.json().catch(() => null);
  if (!PatchBodySchema.safeParse(raw).success) {
    return NextResponse.json(
      {
        error:
          "Only cancelling a draft invoice is allowed here. Contact Familiarise support to change this.",
        code: "INVOICE_CHANGE_PLATFORM_ONLY",
      },
      { status: 403 },
    );
  }

  try {
    const updated = await prisma.$transaction(async (tx) => {
      const current = await tx.organizationInvoice.findFirst({
        where: { id: invoiceId, organizationId: orgId },
      });
      if (!current) {
        throw Object.assign(new Error("Invoice not found"), {
          httpStatus: 404,
        });
      }
      // The friendly error; the CAS below is the race-safe enforcement.
      if (current.status !== "DRAFT") {
        throw Object.assign(
          new Error(
            `Cannot transition invoice from ${current.status} to CANCELLED`,
          ),
          { httpStatus: 409 },
        );
      }

      await transitionOrgInvoice(tx, {
        where: { id: invoiceId, organizationId: orgId },
        to: "CANCELLED",
        // The next GET …/pdf regenerates so the watermark shows the status.
        data: { pdfStoragePath: null, pdfGeneratedAt: null },
        audit: {
          organizationId: orgId,
          actorMembershipId: access.member.id,
          category: "INVOICE",
          action: AUDIT_ACTIONS.INVOICE.INVOICE_CANCELLED,
          description: `Invoice ${current.invoiceNumber}: ${ORG_INVOICE_STATUS_LABEL[current.status]} → ${ORG_INVOICE_STATUS_LABEL.CANCELLED}`,
          details: {
            invoiceId,
            from: current.status,
            to: "CANCELLED",
            ...(current.purchaseOrderId !== null && {
              purchaseOrderId: current.purchaseOrderId,
              restoredPaise: current.totalPaise,
            }),
          },
        },
      });

      // CANCELLED is terminal and the CAS above runs once, so this returns
      // exactly the PO budget the invoice drew down at creation.
      if (current.purchaseOrderId) {
        await tx.purchaseOrder.update({
          where: { id: current.purchaseOrderId },
          data: {
            remainingAmountPaise: { increment: current.totalPaise },
          },
        });
      }

      // updateMany returns no row — re-read in-tx for the response body.
      return tx.organizationInvoice.findUniqueOrThrow({
        where: { id: invoiceId },
      });
    });

    return NextResponse.json({ invoice: updated });
  } catch (err) {
    if (err instanceof Error && "httpStatus" in err) {
      const status = typeof err.httpStatus === "number" ? err.httpStatus : 500;
      return NextResponse.json({ error: err.message }, { status });
    }
    throw err;
  }
}
