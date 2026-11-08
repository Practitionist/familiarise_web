/**
 * POST /api/organizations/[orgId]/billing-account/invoices/[invoiceId]/pay
 *
 * Mints (or reuses) a Razorpay order for what an issued invoice still owes and
 * returns it for hosted checkout. The webhook and bounded gateway healer both
 * settle captures through the same invoice handler. An org awaiting
 * verification may pay; a suspended one may not.
 */

import * as Sentry from "@sentry/nextjs";
import { Prisma } from "@prisma/client";
import { NextResponse, type NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";
import {
  applyOrgInvoiceCapture,
  attemptSettledInvoiceNotices,
  invoiceOutstandingPaise,
  type InvoiceCaptureOutcome,
} from "@/lib/payments/billing/org-invoice-settlement";
import {
  createRazorpayOrder,
  fetchRazorpayOrder,
  readRazorpayOrderHolding,
} from "@/lib/payments/core/razorpay";
import { PaymentError } from "@/lib/payments/core/types";
import { applyRateLimit, moneyOpsLimiter } from "@/lib/rate-limit";
import { withSerializableRetry } from "@/lib/db/serializable-retry";

const GATEWAY_BUDGET_MS = 20_000;
const GATEWAY_CALL_TIMEOUT_MS = 5_000;

function remainingGatewayTimeout(startedAt: number): number {
  return Math.min(
    GATEWAY_CALL_TIMEOUT_MS,
    GATEWAY_BUDGET_MS - (Date.now() - startedAt),
  );
}

export async function POST(
  _req: NextRequest,
  {
    params,
  }: {
    params: Promise<{ orgId: string; invoiceId: string }>;
  },
) {
  const startedAt = Date.now();
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

  let razorpayOrderId: string | null = null;
  if (invoice.providerPaymentOrderId) {
    const existingOrder = await inspectStoredOrder({
      orderId: invoice.providerPaymentOrderId,
      invoiceId,
      orgId,
      amountPaise,
      displayCurrency: invoice.displayCurrency,
      startedAt,
    });
    if ("response" in existingOrder) return existingOrder.response;
    razorpayOrderId = existingOrder.orderId;
  }

  if (!razorpayOrderId) {
    try {
      const remainingMs = GATEWAY_BUDGET_MS - (Date.now() - startedAt);
      const orderTimeoutMs = Math.min(GATEWAY_CALL_TIMEOUT_MS, remainingMs);
      if (orderTimeoutMs <= 0) {
        return NextResponse.json(
          {
            error: "Could not confirm a payment order in time",
            code: "ORDER_UNCONFIRMED",
          },
          { status: 503 },
        );
      }
      const order = await createRazorpayOrder(
        {
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
        },
        orderTimeoutMs,
      );
      const createdOrderId = order.id;

      // A concurrent payer may have attached an order or paid the invoice
      // while this gateway order was being created. Attach by CAS, then use
      // only the current payable row's order.
      const persistedOrderId = await withSerializableRetry(() =>
        prisma.$transaction(
          async (tx) => {
            // A credit may have committed while the external order was being created.
            if (
              (await invoiceOutstandingPaise(tx, invoiceId)) !== amountPaise
            ) {
              return null;
            }
            const claimed = await tx.organizationInvoice.updateMany({
              where: {
                id: invoiceId,
                organizationId: orgId,
                status: { in: ["ISSUED", "OVERDUE"] },
                providerPaymentOrderId: invoice.providerPaymentOrderId,
              },
              data: { providerPaymentOrderId: createdOrderId },
            });
            if (claimed.count === 1) {
              await tx.orgAuditLog.create({
                data: {
                  organizationId: orgId,
                  actorMembershipId: access.member.id,
                  category: "INVOICE",
                  action: AUDIT_ACTIONS.INVOICE.INVOICE_PAYMENT_INITIATED,
                  description: `Payment initiated for invoice ${invoice.invoiceNumber}`,
                  details: {
                    invoiceId,
                    razorpayOrderId: createdOrderId,
                    replacedRazorpayOrderId: invoice.providerPaymentOrderId,
                    amountPaise,
                  },
                },
              });
              return createdOrderId;
            }

            const current = await tx.organizationInvoice.findUnique({
              where: { id: invoiceId },
              select: { status: true, providerPaymentOrderId: true },
            });
            if (
              current &&
              ["ISSUED", "OVERDUE"].includes(current.status) &&
              current.providerPaymentOrderId
            ) {
              return current.providerPaymentOrderId;
            }
            return null;
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        ),
      );

      if (!persistedOrderId) {
        return NextResponse.json(
          {
            error: "Invoice payment state changed; reload the invoice",
            code: "INVOICE_STATE_CHANGED",
          },
          { status: 409 },
        );
      }
      razorpayOrderId = persistedOrderId;
      if (persistedOrderId !== createdOrderId) {
        const winner = await inspectStoredOrder({
          orderId: persistedOrderId,
          invoiceId,
          orgId,
          amountPaise,
          displayCurrency: invoice.displayCurrency,
          startedAt,
        });
        if ("response" in winner) return winner.response;
        if (winner.orderId === null) {
          return NextResponse.json(
            {
              error: "Invoice payment state changed; reload the invoice",
              code: "INVOICE_STATE_CHANGED",
            },
            { status: 409 },
          );
        }
      }
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
      console.error("[invoice/pay] order creation or attachment failed:", err);
      return NextResponse.json(
        {
          error: "Failed to confirm invoice payment order",
          errorType:
            err instanceof PaymentError
              ? err.code
              : "INVOICE_ORDER_SETUP_FAILED",
        },
        { status: 502 },
      );
    }
  }

  if (!razorpayOrderId) {
    return NextResponse.json(
      {
        error: "Could not confirm an invoice payment order",
        code: "ORDER_UNCONFIRMED",
      },
      { status: 503 },
    );
  }

  if (GATEWAY_BUDGET_MS - (Date.now() - startedAt) <= 0) {
    return NextResponse.json(
      {
        error: "Could not confirm a payment order in time",
        code: "ORDER_UNCONFIRMED",
      },
      { status: 503 },
    );
  }

  const rowStillPayable = await withSerializableRetry(() =>
    prisma.$transaction(
      async (tx) => {
        const current = await tx.organizationInvoice.findUnique({
          where: { id: invoiceId },
          select: { status: true, providerPaymentOrderId: true },
        });
        if (
          current !== null &&
          ["ISSUED", "OVERDUE"].includes(current.status) &&
          current.providerPaymentOrderId === razorpayOrderId
        ) {
          return (await invoiceOutstandingPaise(tx, invoiceId)) === amountPaise;
        }
        return false;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
  if (!rowStillPayable) {
    return NextResponse.json(
      {
        error: "Invoice payment state changed; reload the invoice",
        code: "INVOICE_STATE_CHANGED",
      },
      { status: 409 },
    );
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

/** Resolve a stored order before deciding whether another checkout can be created. */
async function inspectStoredOrder(args: {
  orderId: string;
  invoiceId: string;
  orgId: string;
  amountPaise: number;
  displayCurrency: string;
  startedAt: number;
}): Promise<{ orderId: string | null } | { response: NextResponse }> {
  const { orderId, invoiceId, orgId, amountPaise, displayCurrency, startedAt } =
    args;
  const orderTimeoutMs = remainingGatewayTimeout(startedAt);
  if (orderTimeoutMs <= 0) {
    return {
      response: NextResponse.json(
        {
          error: "Could not verify the existing payment order in time",
          code: "ORDER_UNCONFIRMED",
        },
        { status: 503 },
      ),
    };
  }
  let order;
  try {
    order = await fetchRazorpayOrder(orderId, orderTimeoutMs);
  } catch (error) {
    Sentry.captureException(error, {
      tags: { subsystem: "enterprise", operation: "invoice_order_readback" },
      extra: { orgId, invoiceId },
    });
    return {
      response: NextResponse.json(
        {
          error: "Could not verify the existing payment order",
          code: "ORDER_UNCONFIRMED",
        },
        { status: 502 },
      ),
    };
  }
  if (!order) {
    return {
      response: NextResponse.json(
        {
          error: "Payment gateway could not verify the existing order",
          code: "ORDER_UNCONFIRMED",
        },
        { status: 503 },
      ),
    };
  }
  if (
    order.id !== orderId ||
    order.notes.type !== "invoice_payment" ||
    order.notes.invoiceId !== invoiceId ||
    order.notes.organizationId !== orgId ||
    order.currency !== displayCurrency
  ) {
    return {
      response: NextResponse.json(
        {
          error: "Existing order does not match this invoice",
          code: "ORDER_IDENTITY_MISMATCH",
        },
        { status: 409 },
      ),
    };
  }

  if (
    order.status !== "created" &&
    order.status !== "attempted" &&
    order.status !== "paid"
  ) {
    return {
      response: NextResponse.json(
        {
          error: "Existing payment order has an unsupported status",
          code: "ORDER_STATUS_UNCONFIRMED",
        },
        { status: 409 },
      ),
    };
  }

  if (
    order.amount === amountPaise &&
    (order.status === "created" || order.status === "attempted")
  ) {
    return { orderId };
  }

  const holdingTimeoutMs = remainingGatewayTimeout(startedAt);
  if (holdingTimeoutMs <= 0) {
    return {
      response: NextResponse.json(
        {
          error: "Could not verify the existing payment attempt in time",
          code: "ORDER_UNCONFIRMED",
        },
        { status: 503 },
      ),
    };
  }
  let holding;
  try {
    holding = await readRazorpayOrderHolding(orderId, holdingTimeoutMs);
  } catch (error) {
    Sentry.captureException(error, {
      tags: {
        subsystem: "enterprise",
        operation: "invoice_order_capture_readback",
      },
      extra: { orgId, invoiceId },
    });
    return {
      response: NextResponse.json(
        {
          error: "Could not verify the existing payment attempt",
          code: "ORDER_UNCONFIRMED",
        },
        { status: 502 },
      ),
    };
  }

  if (holding.kind === "captured") {
    let outcome: InvoiceCaptureOutcome;
    try {
      outcome = await withSerializableRetry(() =>
        prisma.$transaction(
          async (tx) => {
            const result = await applyOrgInvoiceCapture(tx, {
              invoiceId,
              gatewayPaymentId: holding.paymentId,
              capturedPaise: holding.amountPaise,
              notesOrganizationId: orgId,
            });
            if (result.kind === "PAID") {
              await tx.orgAuditLog.create({
                data: {
                  organizationId: orgId,
                  actorMembershipId: null,
                  category: "INVOICE",
                  action: AUDIT_ACTIONS.INVOICE.INVOICE_PAID,
                  description:
                    "Invoice paid while checking an existing payment order",
                  details: {
                    invoiceId,
                    providerPaymentId: holding.paymentId,
                  },
                },
              });
            }
            return result;
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        ),
      );
    } catch (error) {
      Sentry.captureException(error, {
        tags: {
          subsystem: "enterprise",
          operation: "invoice_capture_recovery",
        },
        extra: { orgId, invoiceId },
      });
      return {
        response: NextResponse.json(
          {
            error: "Captured payment recovery could not be confirmed",
            code: "PAYMENT_RECOVERY_UNCONFIRMED",
          },
          { status: 502 },
        ),
      };
    }
    if (outcome.kind === "PAID") {
      await attemptSettledInvoiceNotices(outcome.settled);
    }
    return {
      response:
        outcome.kind === "UNAPPLIED"
          ? NextResponse.json(
              {
                error: "Captured payment requires operator review",
                code: "PAYMENT_CAPTURE_REQUIRES_REVIEW",
              },
              { status: 409 },
            )
          : NextResponse.json(
              {
                error: "Invoice payment is already captured",
                code: "INVOICE_ALREADY_PAID",
              },
              { status: 409 },
            ),
    };
  }
  if (holding.kind === "live") {
    return {
      response: NextResponse.json(
        {
          error: "The existing payment attempt is still processing",
          code: "PAYMENT_IN_PROGRESS",
        },
        { status: 409 },
      ),
    };
  }
  if (order.status === "paid") {
    return {
      response: NextResponse.json(
        {
          error:
            "Gateway marked this order paid, but its payment is unconfirmed",
          code: "PAYMENT_CAPTURE_UNCONFIRMED",
        },
        { status: 409 },
      ),
    };
  }
  // Replacement still CASes the inspected order and rechecks the current debt.
  return { orderId: null };
}
