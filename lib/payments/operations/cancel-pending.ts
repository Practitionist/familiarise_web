import {
  reportSentryError,
  reportSentryMessage,
} from "@/lib/observability/report";
import prisma from "@/lib/prisma";
import type { Tx } from "@/lib/prisma";
import {
  releaseParticipant,
  transitionParticipant,
} from "@/lib/booking/participants";
import { Prisma, type PaymentGateway } from "@prisma/client";
import { withSerializableRetry } from "@/lib/db/serializable-retry";
import { reverseCreditsForPayment } from "@/lib/referrals/service";
import { returnDiscountUse } from "@/lib/payments/checkout/discount-use";
import { reverseBookingUtilization } from "@/lib/api/organizations/program-helpers";
import {
  transitionConsultationRequest,
  transitionOccurrenceCompletion,
  transitionSubscriptionRequest,
} from "@/lib/booking/transitions";
import { cancelPaymentIntent } from "@/scripts/payments/cleanup-abandoned-payments";
import {
  finishSeatOpenedNotices,
  stageSeatOpenedNotices,
  type StagedSeatOpened,
} from "@/lib/booking/event-waitlist";
import { scheduleAfter } from "@/lib/api/after-safe";

/**
 * #849 — user-initiated release of a tentative checkout hold.
 *
 * A user who abandons checkout otherwise waits for the cleanup cron's next
 * pass inside the 24h tentative window (#833). This is the self-serve path:
 * expire the caller's own PENDING payment, restore referral credits, release
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
  seatOpened?: StagedSeatOpened | null;
}

const CANCEL_NOTE = "Cancelled by user during checkout";

/**
 * Give back whatever the buyer was holding.
 *
 * Group events never mint a per-buyer occurrence: registration adds the buyer
 * to the event's roster, so releasing the seat means releasing that row.
 * Deleting the occurrence would take every other attendee's call with it,
 * and webinar occurrences are non-tentative anyway — which is why the old
 * `deleteMany({ isTentative: true })` released nothing at all.
 */
async function releaseSlots(
  tx: Tx,
  appt: {
    id: string;
    class?: { id: string } | null;
    webinar?: { id: string } | null;
  },
  userId: string,
): Promise<number> {
  if (!appt.class && !appt.webinar) {
    // Doctrine rule 2: freed by status, not by DELETE. The buyer keeps a
    // record of the hold they abandoned, and occupancy already ignores a
    // soft-cancelled row.
    const released = await transitionOccurrenceCompletion(tx, {
      where: { appointmentId: appt.id, isTentative: true, deletedAt: null },
      to: "CANCELLED",
      data: { deletedAt: new Date() },
      allowZero: true,
    });
    // The 1:1 appointment is the buyer's own hold, so its HELD seats go too.
    await transitionParticipant(tx, { appointmentId: appt.id }, "CANCELLED", {
      fromIn: ["HELD"],
    });
    return released;
  }

  const seatFilter = appt.class
    ? { appointment: { classId: appt.class.id } }
    : { appointmentId: appt.id };

  // #1554 — the seat is the participant row; releasing it is a status flip.
  return releaseParticipant(tx, { ...seatFilter, userId });
}

export async function cancelPendingCheckout(args: {
  paymentId: string;
  userId: string;
}): Promise<CancelPendingResult> {
  // Outside the retry, so a retried transaction re-stages the same notice keys.
  const now = new Date();
  const txOut = await withSerializableRetry(() =>
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
          // Authorization-denial-shaped outcome (or a genuinely missing
          // payment) — modelled, reported for visibility only.
          reportSentryMessage(
            "cancelPendingCheckout: not found / not owned by caller",
            {
              subsystem: "payments",
              expected: true,
              extra: { paymentId: args.paymentId },
            },
          );
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
          // Lost CAS race — the webhook/cron/a parallel cancel already won.
          // The system working as designed.
          reportSentryMessage(
            "cancelPendingCheckout: lost CAS race (already terminal)",
            {
              subsystem: "payments",
              expected: true,
              extra: { paymentId: args.paymentId },
            },
          );
          return {
            outcome: { ok: false, code: "NOT_PENDING" },
            gatewayCancel: null,
          };
        }

        // Referral credits consumed at checkout go back to the user —
        // same step the abandoned-payments cron performs.
        await reverseCreditsForPayment(payment.id, tx);
        await returnDiscountUse(tx, payment.id);

        // #1003 — and so does the org's program engagement. Checkout debits
        // BookingUtilization inside the booking transaction, BEFORE capture, so
        // abandoning an org-funded checkout burned a seat against a contracted
        // cap permanently. Idempotent (it derives what is left to reverse from
        // the immutable usage ledger) and a no-op for personal bookings, which
        // have no utilization row.
        await reverseBookingUtilization(tx, {
          paymentId: payment.id,
          reason: CANCEL_NOTE,
        });

        let slotsReleased = 0;
        let seatOpened: StagedSeatOpened | null = null;
        const appt = payment.appointment;
        if (appt) {
          slotsReleased = await releaseSlots(tx, appt, args.userId);
          if ((appt.webinar || appt.class) && slotsReleased > 0) {
            seatOpened = await stageSeatOpenedNotices(tx, appt.id, now);
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
          seatOpened,
          gatewayCancel: payment.isMockPayment
            ? null
            : {
                paymentIntent: payment.paymentIntent,
                gateway: payment.paymentGateway,
              },
        };
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        maxWait: 10_000,
        timeout: 15_000,
      },
    ),
  );

  const { outcome, gatewayCancel, seatOpened } = txOut;
  await scheduleAfter(
    () => finishSeatOpenedNotices(seatOpened),
    "cancel-pending.seat-opened",
  );

  // Best-effort, post-commit: a failed gateway cancel never un-cancels the
  // booking. Razorpay can't cancel orders that already collected a payment —
  // a genuine late capture flips this payment SUCCEEDED via the webhook and
  // the orphaned-confirmation reconciler picks it up for refund.
  if (outcome.ok && gatewayCancel !== null) {
    try {
      await cancelPaymentIntent(
        gatewayCancel.paymentIntent,
        gatewayCancel.gateway,
      );
    } catch (error) {
      reportSentryError(error, { subsystem: "payments" });
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
