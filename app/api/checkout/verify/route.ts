import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireApiAuth } from "@/lib/auth-helpers";
import {
  getRazorpayClient,
  withRazorpaySdkTimeout,
} from "@/lib/payments/core/razorpay";
import { routeCapturedPayment } from "@/app/api/webhooks/razorpay-dispatch";
import { applyRateLimit, checkoutLimiter } from "@/lib/rate-limit";
import { isDeadOccurrence } from "@/lib/appointments/occurrences";
import type { Prisma } from "@prisma/client";

/**
 * #1586 P1-J07/J08 — what the buyer's booking actually is once the money is
 * SUCCEEDED, so the success page can stop inferring "confirmed" from the
 * payment status alone (true for the #827 loser and the amount-mismatch case).
 */
export type BookingState =
  | "CONFIRMED"
  | "PENDING_APPROVAL"
  | "AWAITING_ALLOCATION"
  | "REFUND_PENDING"
  | "REFUNDED";

const VERIFY_INCLUDE = {
  user: true,
  appointment: {
    include: {
      consultation: { include: { consultationPlan: true, requestedBy: true } },
      subscription: { include: { subscriptionPlan: true, requestedBy: true } },
      webinar: { include: { webinarPlan: true } },
      class: { include: { classPlan: true } },
      occurrences: true,
    },
  },
} satisfies Prisma.PaymentInclude;

function loadVerifyPayment(paymentIntent: string) {
  return prisma.payment.findUnique({
    where: { paymentIntent },
    include: VERIFY_INCLUDE,
  });
}

// Typed off the extended client, whose BigInt columns surface as number.
type VerifyPayment = NonNullable<Awaited<ReturnType<typeof loadVerifyPayment>>>;

const PRE_APPROVAL_STATUSES = new Set(["PENDING", "APPROVED_PENDING_PAYMENT"]);

/** Null = the pipeline has not landed yet; the page keeps its "confirming" copy. */
async function deriveBookingState(
  payment: VerifyPayment,
): Promise<BookingState | null> {
  // One extra round-trip: a Phase-2 auto-refund (#837) is the only sign the
  // buyer's money is coming back while paymentStatus still says SUCCEEDED.
  // Internal rails refund instantly, so a SUCCEEDED full refund is "returned",
  // not "on its way"; a partial refund leaves the booking standing.
  const refunds = await prisma.refund.findMany({
    where: { paymentId: payment.id, status: { in: ["PENDING", "SUCCEEDED"] } },
    select: { status: true, amountPaise: true },
  });
  // Only a refund that covers the whole charge means the booking is gone; a
  // partial one (a shaved seat, a reschedule delta) leaves it standing.
  const covered = refunds.reduce((sum, r) => sum + r.amountPaise, 0);
  if (refunds.length > 0 && covered >= payment.amount) {
    return refunds.some((r) => r.status === "PENDING")
      ? "REFUND_PENDING"
      : "REFUNDED";
  }
  const appointment = payment.appointment;
  if (!appointment) return null;
  const request = appointment.consultation ?? appointment.subscription;
  if (request && PRE_APPROVAL_STATUSES.has(request.status)) {
    return "PENDING_APPROVAL";
  }
  const live = appointment.occurrences.filter((o) => !isDeadOccurrence(o));
  if (live.length === 0) {
    const type = appointment.appointmentType;
    return type === "SUBSCRIPTION" || type === "CLASS"
      ? "AWAITING_ALLOCATION"
      : null;
  }
  return live.every((o) => o.isTentative) ? null : "CONFIRMED";
}

export async function GET(req: NextRequest) {
  try {
    const razorpayClient = getRazorpayClient();
    // #1584 P1-AZ01 — force-fresh like POST /api/checkout: ?sync=true drives
    // routeCapturedPayment, so a banned or revoked session must not reach it.
    const authResult = await requireApiAuth();
    if (authResult.error) return authResult.error;
    const { session } = authResult;

    // Get payment intent from query parameters
    const { searchParams } = new URL(req.url);
    const paymentIntent = searchParams.get("payment_intent");
    // L4 FIX: Optional sync=true to fetch latest status from Razorpay
    const shouldSync = searchParams.get("sync") === "true";

    if (!paymentIntent) {
      return NextResponse.json(
        { error: "Payment intent ID is required" },
        { status: 400 },
      );
    }

    // Find payment record with appointment details
    let payment = await loadVerifyPayment(paymentIntent);

    if (!payment) {
      return NextResponse.json({ error: "Payment not found" }, { status: 404 });
    }

    // Verify the payment belongs to the authenticated user
    if (payment.userId !== session.user.id) {
      return NextResponse.json(
        { error: "Unauthorized access to payment" },
        { status: 403 },
      );
    }

    // L4 FIX: On-demand sync — fetch latest status from Razorpay API.
    // Placed AFTER ownership check to prevent unauthorized status updates.
    //
    // ADR 21 — this used to flip the row to SUCCEEDED with a bare updateMany,
    // which made the later `payment.captured` webhook short-circuit on its
    // already-SUCCEEDED early-return and skip appointment confirmation,
    // earnings, and the `booking:<paymentId>` journal entry. It now drives the
    // same idempotent pipeline the webhook drives, so a sync can only ever
    // produce the complete outcome or none of it.
    // #1592 S-P0-05 / #1599 F-P0-02 — the sync arm drives a gateway read and
    // the confirmation pipeline on the caller's say-so, so it is budgeted.
    // Keyed apart from the checkout POST so the success page's poll cannot
    // starve a checkout; when the budget is spent the gateway is simply not
    // asked and the poller gets the "still processing" 400 it already treats
    // as keep-waiting (checkout-success/page.tsx), with `retryAfter` so it can
    // back off — a bare 429 would be rendered as VERIFICATION_FAILED.
    let syncRetryAfter: number | null = null;
    if (
      shouldSync &&
      payment.paymentStatus === "PENDING" &&
      paymentIntent.startsWith("order_") &&
      razorpayClient
    ) {
      const limited = await applyRateLimit(
        checkoutLimiter,
        `verify-sync:${session.user.id}`,
      );
      if (limited) {
        syncRetryAfter = Number(limited.headers.get("Retry-After")) || null;
      }
    }
    if (
      shouldSync &&
      syncRetryAfter === null &&
      payment.paymentStatus === "PENDING" &&
      paymentIntent.startsWith("order_") &&
      razorpayClient
    ) {
      try {
        // Bounded like every other SDK call: a hung gateway must not hold
        // the buyer's poll (or this instance) open.
        const rzpOrder = await withRazorpaySdkTimeout("orders.fetch", () =>
          razorpayClient.orders.fetch(paymentIntent),
        );
        if (rzpOrder.status === "paid") {
          // Resolve the captured payment so the parity check and the
          // notes-based routing both see gateway truth, exactly as the
          // webhook does.
          const orderPayments = await withRazorpaySdkTimeout(
            "orders.fetchPayments",
            () => razorpayClient.orders.fetchPayments(paymentIntent),
          );
          const captured =
            orderPayments.items?.find((p) => p.status === "captured") ??
            orderPayments.items?.[0];

          await routeCapturedPayment({
            orderId: paymentIntent,
            notes: Object.fromEntries(
              Object.entries(captured?.notes ?? rzpOrder.notes ?? {}).map(
                ([k, v]) => [k, String(v)],
              ),
            ),
            amountPaise:
              captured?.amount !== undefined
                ? Number(captured.amount)
                : undefined,
            gatewayPaymentId: captured?.id,
          });

          // Re-read the whole graph: bookingState below reads the request
          // status and the occurrences the pipeline just flipped (#1586).
          const updated = await loadVerifyPayment(paymentIntent);
          if (updated) payment = updated;
        }
      } catch (syncError) {
        // Non-fatal: the webhook and the stuck-event sweeper remain the durable
        // path. Report so a systematically failing sync is visible rather than
        // silently leaving buyers on a spinner.
        Sentry.captureException(
          syncError instanceof Error ? syncError : new Error(String(syncError)),
          { tags: { subsystem: "payments" } },
        );
        console.warn(
          `Failed to sync payment status from Razorpay for ${paymentIntent}:`,
          syncError,
        );
      }
    }

    // Check payment status
    if (payment.paymentStatus !== "SUCCEEDED") {
      return NextResponse.json(
        {
          error: "Payment not completed",
          status: payment.paymentStatus,
          message: getPaymentStatusMessage(payment.paymentStatus),
          ...(syncRetryAfter !== null ? { retryAfter: syncRetryAfter } : {}),
        },
        { status: 400 },
      );
    }

    // Get appointment type from appointment or metadata
    let appointmentType = "UNKNOWN";
    if (payment.appointment) {
      appointmentType = payment.appointment.appointmentType;
    }

    const bookingState = await deriveBookingState(payment);

    // Return success response with appointment details
    return NextResponse.json({
      paymentIntent: payment.paymentIntent,
      appointmentType,
      status: "SUCCEEDED",
      ...(bookingState ? { bookingState } : {}),
      message: "Payment verified successfully",
      appointment: payment.appointment
        ? {
            id: payment.appointment.id,
            type: payment.appointment.appointmentType,
            slots: payment.appointment.occurrences,
            consultation: payment.appointment.consultation,
            subscription: payment.appointment.subscription,
            webinar: payment.appointment.webinar,
            class: payment.appointment.class,
          }
        : null,
      amount: payment.amount,
      currency: payment.currency,
      createdAt: payment.createdAt,
    });
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "checkout" } },
    );
    console.error("Payment verification error:", error);
    // #1586 P1-J32 — a typed 500 so the success page keeps polling instead of
    // routing a possibly-charged buyer to the failure page.
    return NextResponse.json(
      { error: "Internal server error", errorType: "VERIFICATION_FAILED" },
      { status: 500 },
    );
  }
}

function getPaymentStatusMessage(status: string): string {
  switch (status) {
    case "PENDING":
      return "Payment is still being processed. Please wait a few moments and refresh the page.";
    case "FAILED":
      return "Payment failed. Please try again with a different payment method.";
    case "EXPIRED":
      return "Payment session expired. Please start a new checkout.";
    default:
      return "Payment status is unknown. Please contact support.";
  }
}
