/**
 * Payment Recovery Endpoint
 *
 * Builds the appointment for a SUCCEEDED capture whose gateway metadata failed
 * validation, from corrected metadata an admin supplies. The booking target
 * (appointment type, plan, event, trial) must equal the server-minted notes on
 * the payment's Razorpay order, so a recovery cannot book a different expert.
 */

import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { PaymentGateway, PaymentStatus, UserRole } from "@prisma/client";
import { validateWebhookMetadata } from "@/schemas/webhooks/metadata";
import { z, ZodError } from "zod";

import { getSession } from "@/lib/auth-server";
import { withOpsAction } from "@/lib/backoffice/ops-action-log";
import { OpsRefusal } from "@/lib/backoffice/ops-refusal-error";
import { fetchRazorpayOrder } from "@/lib/payments/core/razorpay";
import { isMockPaymentId } from "@/lib/payments/operations/mock";
import { unreturnedCaptureWhere } from "@/lib/payments/webhooks/auto-refund-marker";
// ============================================================================
// GET - Fetch payment details for recovery
// ============================================================================

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ paymentId: string }> },
) {
  try {
    // Authenticate admin/staff
    const session = await getSession();
    if (
      !session?.user?.id ||
      (session.user.role !== UserRole.ADMIN &&
        session.user.role !== UserRole.STAFF)
    ) {
      return NextResponse.json(
        { error: "Unauthorized - Admin access required" },
        { status: 403 },
      );
    }

    const { paymentId } = await params;

    // Fetch payment with full details
    const payment = await prisma.payment.findUnique({
      where: { id: paymentId },
      include: {
        user: {
          include: {
            consulteeProfile: true,
          },
        },
        appointment: {
          include: {
            consultation: true,
            subscription: true,
            webinar: true,
            class: true,
          },
        },
      },
    });

    if (!payment) {
      return NextResponse.json({ error: "Payment not found" }, { status: 404 });
    }

    return NextResponse.json({
      payment: {
        id: payment.id,
        amount: payment.amount,
        currency: payment.currency,
        paymentIntent: payment.paymentIntent,
        paymentStatus: payment.paymentStatus,
        description: payment.description,
        userId: payment.userId,
        appointmentId: payment.appointmentId,
        createdAt: payment.createdAt,
        hasAppointment: !!payment.appointment,
      },
    });
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "payments" } },
    );
    console.error("Error fetching payment for recovery:", error);
    return NextResponse.json(
      { error: "Failed to fetch payment details" },
      { status: 500 },
    );
  }
}

// ============================================================================
// POST - Recover payment by creating appointment with corrected metadata
// ============================================================================

/** The keys that pick what is booked and who earns from it. */
const RECOVER_TARGET_KEYS = [
  "appointmentType",
  "planId",
  "eventId",
  "trialId",
] as const;

/** Empty notes are absent fields, as in `validateWebhookMetadata`. */
const noteValue = (notes: Record<string, string>, key: string) =>
  notes[key] || undefined;

/** The checkout-time notes Razorpay holds for this payment's order. */
async function checkoutNotes(payment: {
  paymentIntent: string;
  paymentGateway: PaymentGateway;
}): Promise<Record<string, string>> {
  const unverifiable = () =>
    new OpsRefusal(
      "RECOVER_TARGET_UNVERIFIABLE",
      "This payment has no Razorpay order whose checkout notes name the booking, so it cannot be recovered here.",
    );
  if (
    payment.paymentGateway !== PaymentGateway.RAZORPAY ||
    !payment.paymentIntent.startsWith("order_") ||
    isMockPaymentId(payment.paymentIntent)
  ) {
    throw unverifiable();
  }
  let order;
  try {
    order = await fetchRazorpayOrder(payment.paymentIntent);
  } catch {
    throw new OpsRefusal(
      "GATEWAY_UNAVAILABLE",
      "Razorpay could not return the checkout order. Try again shortly.",
      502,
    );
  }
  if (order?.id !== payment.paymentIntent) throw unverifiable();
  const notes = order.notes;
  if (
    !noteValue(notes, "appointmentType") ||
    (!noteValue(notes, "planId") && !noteValue(notes, "eventId"))
  ) {
    throw unverifiable();
  }
  return notes;
}

const recoveryNotConfirmed = (outcome: string) =>
  new OpsRefusal(
    "RECOVERY_NOT_CONFIRMED",
    `Recovery could not place the booking (${outcome}); the payment is being refunded.`,
  );

const paymentReturned = () =>
  new OpsRefusal(
    "PAYMENT_RETURNED",
    "This payment has a refund, an owed-refund marker or an open or lost dispute, so it cannot be booked.",
  );

const alreadyRecovered = () =>
  new OpsRefusal(
    "ALREADY_RECOVERED",
    "Payment already has an appointment linked",
  );

export const POST = withOpsAction(
  "payments.manage",
  "payment.recover",
  { metadata: z.record(z.string(), z.string()) },
  {
    mode: "gateway",
    target: ({ params }) => ({ kind: "Payment", id: params.paymentId }),
    run: async ({ params, body }) => {
      const payment = await prisma.payment.findUnique({
        where: { id: params.paymentId },
        select: {
          id: true,
          paymentIntent: true,
          paymentGateway: true,
          paymentStatus: true,
          appointmentId: true,
        },
      });
      if (!payment) {
        throw new OpsRefusal("PAYMENT_NOT_FOUND", "Payment not found", 404);
      }
      if (payment.paymentStatus !== PaymentStatus.SUCCEEDED) {
        throw new OpsRefusal(
          "PAYMENT_NOT_SUCCEEDED",
          `Payment status is ${payment.paymentStatus}. Can only recover SUCCEEDED payments.`,
          400,
        );
      }
      // Already linked: the same answer the CAS miss gives below (qa-1753).
      if (payment.appointmentId) throw alreadyRecovered();
      const unreturned = await prisma.payment.count({
        where: { id: payment.id, ...unreturnedCaptureWhere },
      });
      if (unreturned === 0) throw paymentReturned();

      try {
        validateWebhookMetadata(body.metadata);
      } catch (validationError) {
        const details =
          validationError instanceof ZodError
            ? validationError.errors
                .map((e) => `${e.path.join(".")}: ${e.message}`)
                .join("; ")
            : validationError instanceof Error
              ? validationError.message
              : String(validationError);
        throw new OpsRefusal(
          "INVALID_METADATA",
          `Metadata validation failed: ${details}`,
          400,
        );
      }

      const notes = await checkoutNotes(payment);
      const mismatched = RECOVER_TARGET_KEYS.filter(
        (key) => noteValue(notes, key) !== noteValue(body.metadata, key),
      );
      if (mismatched.length > 0) {
        throw new OpsRefusal(
          "RECOVER_TARGET_MISMATCH",
          `The recovery must book what the buyer paid for; ${mismatched.join(", ")} differ from the checkout order.`,
        );
      }

      // Import handlePaymentSuccess dynamically to avoid circular dependencies
      const {
        handlePaymentSuccess,
        RecoveryAlreadyDoneError,
        RecoveryRefusedError,
      } = await import("@/lib/payments/webhooks/handlers");

      // `recover: true` lets a SUCCEEDED, unlinked row past the idempotency
      // short-circuit; the link write's CAS makes two concurrent recoveries
      // build one appointment, and the loser answers ALREADY_RECOVERED.
      let outcome;
      try {
        outcome = await handlePaymentSuccess(
          payment.paymentIntent,
          body.metadata,
          undefined,
          undefined,
          { recover: true },
        );
      } catch (recoveryError) {
        if (
          recoveryError instanceof RecoveryAlreadyDoneError ||
          recoveryError instanceof RecoveryRefusedError
        ) {
          throw new OpsRefusal(
            recoveryError.code,
            recoveryError.message,
            recoveryError.httpStatus,
          );
        }
        throw recoveryError;
      }
      if (outcome === null) throw alreadyRecovered();
      // Any other outcome is Phase 1 refusing the booking (overlap, released
      // hold, amount mismatch) with Phase 2 refunding the money.
      if (outcome !== "confirmed") throw recoveryNotConfirmed(outcome);

      const updatedPayment = await prisma.payment.findUnique({
        where: { id: params.paymentId },
        include: {
          appointment: {
            include: {
              consultation: true,
              subscription: true,
              webinar: true,
              class: true,
            },
          },
        },
      });

      return {
        target: { kind: "Payment", id: payment.id },
        after: { appointmentId: updatedPayment?.appointmentId ?? null },
        response: {
          success: true,
          message: "Payment recovered successfully - appointment created",
          payment: {
            id: updatedPayment?.id,
            appointmentId: updatedPayment?.appointmentId,
            paymentStatus: updatedPayment?.paymentStatus,
          },
          appointment: updatedPayment?.appointment,
        },
      };
    },
  },
  { stepUp: true },
);
