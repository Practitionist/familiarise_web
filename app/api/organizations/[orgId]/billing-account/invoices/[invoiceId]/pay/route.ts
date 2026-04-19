/**
 * POST /api/organizations/[orgId]/billing-account/invoices/[invoiceId]/pay
 *
 * Initiates an invoice-payment Razorpay order. The order carries
 * `notes.type = "invoice_payment"` so the webhook handler at
 * /api/webhooks/razorpay routes it to the invoice-settle path (see
 * app/api/webhooks/utils.ts#handleOrgPaymentSuccess), which transitions
 * the invoice ISSUED → PAID atomically.
 *
 * This endpoint does NOT settle the invoice itself — doing so client-
 * side would leave a race where the client thinks it's paid before
 * Razorpay confirms. The webhook is the only path that mutates
 * invoice.status to PAID.
 */

import { NextResponse, type NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import { requireOrgOwner } from "@/lib/auth-helpers";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";

export async function POST(
  _req: NextRequest,
  {
    params,
  }: {
    params: Promise<{ orgId: string; invoiceId: string }>;
  },
) {
  const { orgId, invoiceId } = await params;
  const access = await requireOrgOwner(orgId);
  if (access.error) return access.error;

  const invoice = await prisma.organizationInvoice.findFirst({
    where: { id: invoiceId, organizationId: orgId },
    select: {
      id: true,
      status: true,
      invoiceNumber: true,
      totalPaise: true,
      displayCurrency: true,
      paidAt: true,
    },
  });
  if (!invoice) {
    return NextResponse.json({ error: "Invoice not found" }, { status: 404 });
  }
  if (invoice.status === "PAID") {
    return NextResponse.json(
      { error: "Invoice already paid", paidAt: invoice.paidAt },
      { status: 409 },
    );
  }
  if (!["ISSUED", "OVERDUE"].includes(invoice.status)) {
    return NextResponse.json(
      {
        error: `Cannot pay an invoice in ${invoice.status} state`,
        invoiceStatus: invoice.status,
      },
      { status: 409 },
    );
  }

  // Razorpay order creation is stubbed — returning an order id shape
  // that the client can feed into the Razorpay SDK. A production build
  // would call `razorpay.orders.create` and persist the real ID on
  // the invoice. The webhook at /api/webhooks/razorpay reads the
  // `notes.invoiceId` + `notes.orgProfileId` metadata to settle.
  const providerOrderId = `order_invpay_${invoiceId.slice(0, 8)}_${Date.now()}`;

  await prisma.orgAuditLog.create({
    data: {
      organizationId: orgId,
      actorMembershipId: access.member.id,
      category: "INVOICE",
      action: AUDIT_ACTIONS.INVOICE.INVOICE_PAYMENT_INITIATED,
      description: `Payment initiated for invoice ${invoice.invoiceNumber}`,
      details: {
        invoiceId,
        providerOrderId,
        totalPaise: invoice.totalPaise,
      },
    },
  });

  return NextResponse.json({
    providerOrderId,
    amountPaise: invoice.totalPaise,
    currency: invoice.displayCurrency,
    invoice: {
      id: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      status: invoice.status,
    },
    // The webhook payload needs these notes to route the confirmation;
    // included in the response so the client can forward them to
    // Razorpay's checkout.
    razorpayNotes: {
      type: "invoice_payment",
      invoiceId,
      orgProfileId: orgId,
    },
  });
}
