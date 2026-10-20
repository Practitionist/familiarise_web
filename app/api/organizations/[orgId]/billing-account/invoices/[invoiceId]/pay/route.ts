/**
 * POST /api/organizations/[orgId]/billing-account/invoices/[invoiceId]/pay
 *
 * Mints (or reuses) a Razorpay order for what an issued invoice still owes and
 * returns it for hosted checkout. Only the webhook settles the invoice; the
 * order's `notes.type = "invoice_payment"` routes the capture there. An org
 * awaiting verification may pay; a suspended one may not.
 */

import * as Sentry from "@sentry/nextjs";
import { NextResponse, type NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";
import { invoiceOutstandingPaise } from "@/lib/payments/billing/org-invoice-settlement";
import {
  createRazorpayOrder,
  fetchRazorpayOrder,
} from "@/lib/payments/core/razorpay";
import { PaymentError } from "@/lib/payments/core/types";
import { applyRateLimit, moneyOpsLimiter } from "@/lib/rate-limit";

export async function POST(
  _req: NextRequest,
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
  });
  if (access.error) return access.error;
  if (access.org.status === "SUSPENDED") {
    return NextResponse.json(
      {
        error: "ORG_SUSPENDED",
        message: "This organisation is suspended; contact Familiarise support.",
      },
      { status: 409 },
    );
  }

  // #677/PM-36 — pay initiates a gateway order for a statutory document.
  // #1236-triage — per-ACTOR key (see pdf route note).
  const limited = await applyRateLimit(
    moneyOpsLimiter,
    access.member?.id ?? orgId,
  );
  if (limited) return limited;

  const invoice = await prisma.organizationInvoice.findFirst({
    where: { id: invoiceId, organizationId: orgId },
    select: {
      id: true,
      status: true,
      invoiceNumber: true,
      displayCurrency: true,
      paidAt: true,
      providerPaymentOrderId: true,
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

  const amountPaise = await invoiceOutstandingPaise(prisma, invoiceId);
  if (amountPaise <= 0) {
    return NextResponse.json(
      {
        error: "Nothing is outstanding on this invoice",
        code: "NOTHING_OUTSTANDING",
      },
      { status: 409 },
    );
  }

  let razorpayOrderId: string;
  const reusable = invoice.providerPaymentOrderId
    ? await isReusableOrder(invoice.providerPaymentOrderId, amountPaise)
    : false;
  if (reusable && invoice.providerPaymentOrderId) {
    razorpayOrderId = invoice.providerPaymentOrderId;
  } else {
    try {
      const order = await createRazorpayOrder({
        amount: amountPaise,
        currency: invoice.displayCurrency,
        paymentGateway: "RAZORPAY",
        // PaymentIntentParams.metadata insists on appointmentId/Type for
        // booking flows; invoice payments don't have an appointment so
        // we pass empty strings. The webhook routes purely off
        // `notes.type === "invoice_payment"` + `notes.invoiceId`.
        metadata: {
          appointmentId: "",
          appointmentType: "",
          type: "invoice_payment",
          invoiceId,
          organizationId: orgId,
          invoiceNumber: invoice.invoiceNumber,
        },
      });
      razorpayOrderId = order.id;
    } catch (err) {
      if (
        err instanceof PaymentError &&
        err.code === "RAZORPAY_NOT_INITIALIZED"
      ) {
        Sentry.logger.warn("[invoice/pay] Razorpay gateway not configured", {
          tags: { subsystem: "enterprise" },
          extra: { orgId, invoiceId },
        });
        return NextResponse.json(
          {
            error:
              "Payment gateway not configured. Set RAZORPAY_KEY_ID and RAZORPAY_SECRET to enable invoice payments.",
            errorType: err.code,
          },
          { status: 503 },
        );
      }
      Sentry.captureException(
        err instanceof Error ? err : new Error(String(err)),
        { tags: { subsystem: "enterprise" }, extra: { orgId, invoiceId } },
      );
      console.error("[invoice/pay] createRazorpayOrder failed:", err);
      return NextResponse.json(
        {
          error:
            err instanceof Error
              ? err.message
              : "Failed to initiate Razorpay order",
          errorType:
            err instanceof PaymentError ? err.code : "RAZORPAY_ORDER_FAILED",
        },
        { status: 502 },
      );
    }

    // Persist the order id + audit log atomically so the next retry
    // sees the order id (and audit writes tie to the gateway side-effect).
    try {
      await prisma.$transaction(async (tx) => {
        const claimed = await tx.organizationInvoice.updateMany({
          where: {
            id: invoiceId,
            providerPaymentOrderId: invoice.providerPaymentOrderId,
          },
          data: { providerPaymentOrderId: razorpayOrderId },
        });
        if (claimed.count === 0) {
          const current = await tx.organizationInvoice.findUnique({
            where: { id: invoiceId },
            select: { providerPaymentOrderId: true },
          });
          if (current?.providerPaymentOrderId) {
            razorpayOrderId = current.providerPaymentOrderId;
            return;
          }
          // A receipt or parked capture cleared the stale order meanwhile; claim the empty slot.
          await tx.organizationInvoice.updateMany({
            where: { id: invoiceId, providerPaymentOrderId: null },
            data: { providerPaymentOrderId: razorpayOrderId },
          });
        }
        await tx.orgAuditLog.create({
          data: {
            organizationId: orgId,
            actorMembershipId: access.member.id,
            category: "INVOICE",
            action: AUDIT_ACTIONS.INVOICE.INVOICE_PAYMENT_INITIATED,
            description: `Payment initiated for invoice ${invoice.invoiceNumber}`,
            details: {
              invoiceId,
              razorpayOrderId,
              amountPaise,
            },
          },
        });
      });
    } catch (err) {
      // Gateway order already live — log but return it so the client
      // can proceed. The webhook still honours the order on capture.
      Sentry.captureException(
        err instanceof Error ? err : new Error(String(err)),
        {
          tags: { subsystem: "enterprise" },
          extra: { orgId, invoiceId, razorpayOrderId },
        },
      );
      console.error(
        "[invoice/pay] failed to persist providerPaymentOrderId/audit log:",
        err,
      );
    }
  }

  return NextResponse.json({
    // `razorpayOrderId` (`order_<…>`) drives Razorpay checkout
    // (`new Razorpay({ order_id })`); Razorpay echoes the order's
    // `notes` back on capture so the webhook can route the
    // confirmation without the client forwarding anything itself.
    razorpayOrderId,
    keyId: process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID,
    amountPaise,
    currency: invoice.displayCurrency,
    invoice: {
      id: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      status: invoice.status,
    },
  });
}

/** A cached order is reused only while it is unpaid and still for the outstanding amount. */
async function isReusableOrder(
  orderId: string,
  amountPaise: number,
): Promise<boolean> {
  try {
    const order = await fetchRazorpayOrder(orderId);
    return order?.amount === amountPaise && order.status !== "paid";
  } catch {
    return false;
  }
}
