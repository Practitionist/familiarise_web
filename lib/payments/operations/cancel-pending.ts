import * as Sentry from "@sentry/nextjs";
import prisma from "@/lib/prisma";
import type { Tx } from "@/lib/prisma";
import { Prisma, type PaymentGateway } from "@prisma/client";
import { withSerializableRetry } from "@/lib/db/serializable-retry";
import { reverseCreditsForPayment } from "@/lib/referrals/service";
import {
  transitionConsultationRequest,
  transitionSubscriptionRequest,
} from "@/lib/booking/transitions";
import { cancelPaymentIntent } from "@/scripts/payments/cleanup-abandoned-payments";

/**
 * #849 — user-initiated release of a tentative checkout hold.
 *
 * A user who abandons checkout otherwise waits for the cleanup cron's next
 * pass inside the 24h tentative window (#833). This is the self-serve path:
 * expire the caller's own PENDING payment, restore referral credits, delete
 * the tentative slots, and cancel the parent request.
 *
 * Race posture (#836/#838 doctrine): the whole body runs in one Serializable
 * transaction whose first write is a CAS claim on the payment
 * (PENDING → EXPIRED via guarded updateMany). The capture webhook's confirm
 * path is Serializable too, so cancel-vs-confirm has exactly one winner —
 * the loser aborts (P2034, retried) or finds the payment already terminal.
 *
 * The parent transition uses a NARROW from-set: only PENDING /
 * APPROVED_PENDING_PAYMENT. An APPROVED or SCHEDULED parent means another
 * payment already succeeded for it — this endpoint must never cancel those,
 * so the IllegalTransitionError rolls the whole cancellation back.
 */

export type CancelPendingResult =
  | { ok: true; slotsReleased: number }
  | { ok: false; code: "NOT_FOUND" | "NOT_PENDING" };

interface GatewayCancel {
  paymentIntent: string;
  gateway: PaymentGateway;
}

interface TxOutcome {
  outcome: CancelPendingResult;
  // Returned FROM the transaction (never via outer-scope mutation): an
  // aborted Serializable attempt that retries into an early-exit path must
  // not leave a stale value behind — a stale gatewayCancel would cancel a
  // gateway order this run did NOT expire.
  gatewayCancel: GatewayCancel | null;
}

const CANCEL_NOTE = "Cancelled by user during checkout";

export async function cancelPendingCheckout(args: {
  paymentId: string;
  userId: string;
}): Promise<CancelPendingResult> {
  const { outcome, gatewayCancel } = await withSerializableRetry(() =>
    prisma.$transaction(
      async (tx: Tx): Promise<TxOutcome> => {
        const payment = await tx.payment.findUnique({
          where: { id: args.paymentId },
          select: {
            id: true,
            userId: true,
            paymentStatus: true,
            paymentIntent: true,
            paymentGateway: true,
            isMockPayment: true,
            appointment: {
              select: {
                id: true,
                consultation: { select: { id: true } },
                subscription: { select: { id: true } },
                webinar: { select: { id: true } },
                class: { select: { id: true } },
              },
            },
          },
        });
        // Foreign payments 404 like missing ones — don't leak existence.
        if (!payment || payment.userId !== args.userId) {
          return {
            outcome: { ok: false, code: "NOT_FOUND" },
            gatewayCancel: null,
          };
        }

        // CAS claim — the race closer. count 0 ⇒ the webhook confirmed it,
        // the cleanup cron expired it, or a parallel cancel won.
        const claimed = await tx.payment.updateMany({
          where: {
            id: payment.id,
            userId: args.userId,
            paymentStatus: "PENDING",
          },
          data: { paymentStatus: "EXPIRED" },
        });
        if (claimed.count === 0) {
          return {
            outcome: { ok: false, code: "NOT_PENDING" },
            gatewayCancel: null,
          };
        }

        // Referral credits consumed at checkout go back to the user —
        // same step the abandoned-payments cron performs.
        await reverseCreditsForPayment(payment.id, tx);

        let slotsReleased = 0;
        const appt = payment.appointment;
        if (appt) {
          if (appt.class) {
            // Classes span one appointment per session; payment links only
            // the first — release the caller's tentative slots across all
            // of them (mirror of the webhook's confirm scope).
            const res = await tx.slotOfAppointment.deleteMany({
              where: {
                appointment: { classId: appt.class.id },
                isTentative: true,
                user: { some: { id: args.userId } },
              },
            });
            slotsReleased = res.count;
          } else if (appt.webinar) {
            // Webinars share one appointment among all participants —
            // touch only the caller's tentative slot.
            const res = await tx.slotOfAppointment.deleteMany({
              where: {
                appointmentId: appt.id,
                isTentative: true,
                user: { some: { id: args.userId } },
              },
            });
            slotsReleased = res.count;
          } else {
            const res = await tx.slotOfAppointment.deleteMany({
              where: { appointmentId: appt.id, isTentative: true },
            });
            slotsReleased = res.count;
          }

          if (appt.consultation) {
            await transitionConsultationRequest(tx, {
              where: { id: appt.consultation.id },
              to: "CANCELLED",
              fromIn: ["PENDING", "APPROVED_PENDING_PAYMENT"],
              data: {
                cancellationNotes: CANCEL_NOTE,
                cancelledAt: new Date(),
              },
            });
          }
          if (appt.subscription) {
            await transitionSubscriptionRequest(tx, {
              where: { id: appt.subscription.id },
              to: "CANCELLED",
              fromIn: ["PENDING", "APPROVED_PENDING_PAYMENT"],
              data: {
                cancellationNotes: CANCEL_NOTE,
                cancelledAt: new Date(),
              },
            });
          }
          // Webinar/class are capacity events — no parent transition; the
          // event itself stays SCHEDULED for everyone else.
        }

        return {
          outcome: { ok: true, slotsReleased },
          gatewayCancel: payment.isMockPayment
            ? null
            : {
                paymentIntent: payment.paymentIntent,
                gateway: payment.paymentGateway,
              },
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );

  // Best-effort, post-commit: a failed gateway cancel never un-cancels the
  // booking. Razorpay can't cancel orders that already collected a payment —
  // a genuine late capture flips this payment SUCCEEDED via the webhook and
  // the orphaned-confirmation reconciler picks it up for refund.
  if (outcome.ok && gatewayCancel !== null) {
    try {
      await cancelPaymentIntent(gatewayCancel.paymentIntent, gatewayCancel.gateway);
    } catch (error) {
      Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "payments" } });
      console.warn(
        JSON.stringify({
          event: "cancel_pending_gateway_cancel_failed",
          paymentId: args.paymentId,
          gateway: gatewayCancel.gateway,
          error: error instanceof Error ? error.message : String(error),
          timestamp: new Date().toISOString(),
        }),
      );
    }
  }

  return outcome;
}
