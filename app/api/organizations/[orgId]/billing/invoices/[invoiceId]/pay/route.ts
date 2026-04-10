/**
 * Initiate gateway payment for an outstanding org invoice.
 *
 * POST — ORG_OWNER. Returns the gateway intent / order ID for the client SDK.
 *
 * Phase K replaces the stub return below with a real gateway intent
 * (Razorpay/Stripe) and a webhook handler that flips the invoice to PAID.
 * For now we 200 with `pendingPhaseK` so the dashboard can wire up the button
 * without blocking on payment plumbing.
 */

import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { createRazorpayOrder } from "@/lib/payments/core/razorpay";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ orgId: string; invoiceId: string }> },
) {
  try {
    const { orgId, invoiceId } = await params;
    const access = await requireOrgAccess(orgId, "ORG_OWNER");
    if (access.error) return access.error;

    const invoice = await prisma.organizationInvoice.findFirst({
      where: { id: invoiceId, organizationProfileId: access.org.id },
    });
    if (!invoice) {
      return NextResponse.json(
        { error: "Invoice not found" },
        { status: 404 },
      );
    }
    if (invoice.status === "PAID") {
      return NextResponse.json(
        { error: "Invoice has already been paid." },
        { status: 400 },
      );
    }
    if (invoice.status === "CANCELLED") {
      return NextResponse.json(
        { error: "Invoice has been cancelled." },
        { status: 400 },
      );
    }

    // Create a Razorpay order for the invoice amount. The webhook
    // (payment.captured / order.paid) matches by metadata.type=invoice_payment
    // + metadata.invoiceId to flip the invoice to PAID.
    const order = await createRazorpayOrder({
      amount: invoice.amount,
      currency: invoice.currency,
      metadata: {
        appointmentId: invoiceId,
        appointmentType: "ORG_INVOICE_PAYMENT",
        orgId,
        invoiceId,
        orgProfileId: access.org.id,
        type: "invoice_payment",
      },
      paymentGateway: "RAZORPAY",
    });

    return NextResponse.json({
      orderId: order.id,
      invoiceId: invoice.id,
      amount: order.amount,
      currency: order.currency,
      key: process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID,
    });
  } catch (error) {
    console.error(
      "[API /organizations/[orgId]/billing/invoices/[invoiceId]/pay POST] error:",
      error,
    );
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to initiate payment",
      },
      { status: 500 },
    );
  }
}
