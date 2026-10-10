/**
 * #1527 decision 11 — the one front door out of a booking the buyer has not
 * paid for.
 *
 * Before this there were three exits with three semantics: the cancel route
 * (consultation and subscription only, so a trial's Cancel on Home answered
 * 403, CE-01), the checkout-hold DELETE (keyed by payment, not booking) and
 * the trial DELETE (which also refunds). This module dispatches per kind:
 *   - consultation / subscription: the request goes to CANCELLED;
 *   - trial: the trial goes to CANCELLED and its held session is tombstoned;
 *   - webinar / class: the caller's HELD seat is released; the event itself
 *     stays live for everyone else.
 * In every arm the caller's PENDING payment expires, its referral credits and
 * org engagement come back, and the gateway order is cancelled after commit.
 *
 * The buyer decided, so the outcome is CANCELLED; the `paymentDueAt` sweep
 * stays the backstop and ends in EXPIRED because nobody acted (doctrine rule
 * 5). A booking with a SUCCEEDED payment is refused with ALREADY_PAID: money
 * has moved, so the policy-quoted cancel owns it. That refusal is not only a
 * pre-check — the money predicate rides every CAS WHERE below, so a capture
 * committing between the read and the write matches zero rows instead of
 * cancelling a paid booking.
 */
import { Prisma, type PaymentGateway } from "@prisma/client";

import prisma, { type Tx } from "@/lib/prisma";
import { withSerializableRetry } from "@/lib/db/serializable-retry";
import { IllegalTransitionError } from "@/lib/enterprise/transitions";
import { reportSentryError } from "@/lib/observability/report";
import { reverseCreditsForPayment } from "@/lib/referrals/service";
import { reverseBookingUtilization } from "@/lib/api/organizations/program-helpers";
import { softCancelTrialAppointmentInTx } from "@/lib/trials/cancellation";
import { cancelPaymentIntent } from "@/scripts/payments/cleanup-abandoned-payments";
import {
  renewAppointmentLock,
  withAppointmentLock,
} from "@/utils/appointmentlock";

import { stageNoticesForAppointmentHolds } from "./backup-interest";
import { releaseParticipant } from "./participants";
import { declineOpenReschedules } from "./reschedule-decline";
import {
  SLOT_RESCHEDULABLE_FROM,
  transitionConsultationRequest,
  transitionOccurrenceCompletion,
  transitionSubscriptionRequest,
  transitionTrial,
} from "./transitions";

export type AbandonKind =
  "consultation" | "subscription" | "trial" | "webinar" | "class";

export type AbandonResult =
  | {
      ok: true;
      kind: AbandonKind;
      paymentsExpired: number;
      slotsReleased: number;
    }
  | {
      ok: false;
      /**
       * NOT_FOUND also covers "not yours", so the door is no oracle for other
       * people's bookings. NOT_ABANDONABLE is a booking that has already moved
       * on (confirmed, cancelled, expired); ALREADY_PAID points at the cancel.
       */
      code: "NOT_FOUND" | "NOT_ABANDONABLE" | "ALREADY_PAID";
    };

const ABANDON_NOTE = "Abandoned by the buyer before payment";

/** Only an unpaid request may be abandoned; APPROVED and beyond hold money. */
const ABANDONABLE_REQUEST_FROM = [
  "PENDING",
  "APPROVED_PENDING_PAYMENT",
] as const;
const ABANDONABLE_TRIAL_FROM = ["PENDING", "AWAITING_PAYMENT"] as const;

/**
 * Rule 5's money predicate for a request, repeated inside the CAS. The OR
 * keeps a request with no wrapper yet in scope: a to-one filter on its own
 * would silently exclude it.
 */
const NO_CAPTURED_WRAPPER = {
  OR: [
    { appointment: null },
    { appointment: { payment: { none: { paymentStatus: "SUCCEEDED" } } } },
  ],
} satisfies Prisma.ConsultationWhereInput & Prisma.SubscriptionWhereInput;

interface GatewayCancel {
  paymentIntent: string;
  gateway: PaymentGateway;
}

interface AbandonTarget {
  appointmentId: string;
  userId: string;
  kind: AbandonKind;
  requestId: string | null;
  organizationId: string | null;
}

type TxOutcome =
  | { ok: false; code: "NOT_ABANDONABLE" | "ALREADY_PAID" }
  | {
      ok: true;
      paymentsExpired: number;
      slotsReleased: number;
      // Returned from the transaction, never mutated from outside it, so an
      // aborted Serializable attempt cannot leave a stale gateway cancel for
      // an order this run did not expire (the cancel-pending posture).
      gatewayCancels: GatewayCancel[];
    };

/**
 * Expire the caller's PENDING payment on this booking and give back what the
 * checkout consumed. PENDING → EXPIRED is a CAS, so a capture racing it keeps
 * its SUCCEEDED; the Serializable isolation around the whole body makes that
 * race one winner and one retry.
 */
async function expireCallerPendingPayments(
  tx: Tx,
  target: AbandonTarget,
): Promise<{ expired: number; gatewayCancels: GatewayCancel[] }> {
  const pending = await tx.payment.findMany({
    where: {
      appointmentId: target.appointmentId,
      userId: target.userId,
      paymentStatus: "PENDING",
    },
    select: {
      id: true,
      paymentIntent: true,
      paymentGateway: true,
      isMockPayment: true,
    },
  });
  const gatewayCancels: GatewayCancel[] = [];
  let expired = 0;
  for (const payment of pending) {
    const claimed = await tx.payment.updateMany({
      where: { id: payment.id, paymentStatus: "PENDING" },
      data: { paymentStatus: "EXPIRED" },
    });
    if (claimed.count === 0) continue;
    expired += 1;
    // The same two give-backs the checkout-hold DELETE and the cleanup sweep
    // perform: referral credits spent at checkout, and the org engagement
    // checkout debited before capture (#1003). Both are idempotent.
    await reverseCreditsForPayment(payment.id, tx);
    await reverseBookingUtilization(tx, {
      paymentId: payment.id,
      reason: ABANDON_NOTE,
    });
    if (!payment.isMockPayment) {
      gatewayCancels.push({
        paymentIntent: payment.paymentIntent,
        gateway: payment.paymentGateway,
      });
    }
  }
  return { expired, gatewayCancels };
}

/** Consultation or subscription: the request itself ends CANCELLED. */
async function abandonRequest(
  tx: Tx,
  target: AbandonTarget & { requestId: string },
): Promise<TxOutcome> {
  const cancelledAt = new Date();
  const audit = {
    actorUserId: target.userId,
    reason: ABANDON_NOTE,
    organizationId: target.organizationId,
    appointmentId: target.appointmentId,
  };
  const data = {
    cancellationNotes: ABANDON_NOTE,
    cancelledAt,
    cancelledBy: target.userId,
  };
  try {
    if (target.kind === "consultation") {
      await transitionConsultationRequest(tx, {
        ...audit,
        where: { id: target.requestId, ...NO_CAPTURED_WRAPPER },
        to: "CANCELLED",
        fromIn: [...ABANDONABLE_REQUEST_FROM],
        data,
      });
    } else {
      await transitionSubscriptionRequest(tx, {
        ...audit,
        where: { id: target.requestId, ...NO_CAPTURED_WRAPPER },
        to: "CANCELLED",
        fromIn: [...ABANDONABLE_REQUEST_FROM],
        data,
      });
    }
  } catch (err) {
    if (err instanceof IllegalTransitionError) {
      return { ok: false, code: await refusalFor(tx, target) };
    }
    throw err;
  }

  const { expired, gatewayCancels } = await expireCallerPendingPayments(
    tx,
    target,
  );
  // Anyone waiting on these times hears they are free (#1778), read before the
  // release below stops them counting as held.
  await stageNoticesForAppointmentHolds(tx, target.appointmentId);
  const slotsReleased = await transitionOccurrenceCompletion(tx, {
    ...audit,
    where: { appointmentId: target.appointmentId, deletedAt: null },
    to: "CANCELLED",
    // Doctrine rule 2: released by status plus tombstone, never deleted.
    data: { deletedAt: cancelledAt },
    fromIn: [...SLOT_RESCHEDULABLE_FROM],
    allowZero: true,
  });
  await releaseParticipant(tx, { appointmentId: target.appointmentId });
  await declineOpenReschedules(tx, target.appointmentId, audit);
  return {
    ok: true,
    paymentsExpired: expired,
    slotsReleased,
    gatewayCancels,
  };
}

/** A trial the buyer never paid for: CANCELLED, and its held call retired. */
async function abandonTrial(
  tx: Tx,
  target: AbandonTarget & { requestId: string },
): Promise<TxOutcome> {
  try {
    await transitionTrial(tx, {
      actorUserId: target.userId,
      reason: ABANDON_NOTE,
      organizationId: target.organizationId,
      where: { id: target.requestId },
      to: "CANCELLED",
      fromIn: [...ABANDONABLE_TRIAL_FROM],
      // The capture webhook stamps paymentId, so a null here is the money
      // predicate; the appointment arm catches a capture whose stamp is late.
      whereAnd: {
        paymentId: null,
        NOT: {
          appointment: {
            is: { payment: { some: { paymentStatus: "SUCCEEDED" } } },
          },
        },
      },
      // A dead link must not send a stale dashboard row to checkout.
      data: { pendingPaymentUrl: null, paymentDueAt: null },
    });
  } catch (err) {
    if (err instanceof IllegalTransitionError) {
      return { ok: false, code: await refusalFor(tx, target) };
    }
    throw err;
  }
  const { expired, gatewayCancels } = await expireCallerPendingPayments(
    tx,
    target,
  );
  const slotsReleased = await softCancelTrialAppointmentInTx(
    tx,
    target.appointmentId,
  );
  return {
    ok: true,
    paymentsExpired: expired,
    slotsReleased,
    gatewayCancels,
  };
}

/**
 * A webinar or class seat hold: only the caller's HELD row is released, and
 * HELD is the CAS — the capture webhook flips it to CONFIRMED in its own
 * Serializable transaction, so a seat that got paid matches nothing here.
 */
async function abandonSeat(tx: Tx, target: AbandonTarget): Promise<TxOutcome> {
  const released = await releaseParticipant(tx, {
    appointmentId: target.appointmentId,
    userId: target.userId,
    role: "CONSULTEE",
    status: "HELD",
    // The seat's own payment must not have captured (the confirm may lag).
    NOT: { payment: { is: { paymentStatus: "SUCCEEDED" } } },
  });
  if (released === 0) {
    return { ok: false, code: await refusalFor(tx, target) };
  }
  const { expired, gatewayCancels } = await expireCallerPendingPayments(
    tx,
    target,
  );
  return {
    ok: true,
    paymentsExpired: expired,
    slotsReleased: released,
    gatewayCancels,
  };
}

/** Why a CAS missed, for the answer only: paid points at cancel, else moved on. */
async function refusalFor(
  tx: Tx,
  target: AbandonTarget,
): Promise<"NOT_ABANDONABLE" | "ALREADY_PAID"> {
  const paid = await tx.payment.count({
    where: {
      appointmentId: target.appointmentId,
      paymentStatus: "SUCCEEDED",
      ...(target.kind === "webinar" || target.kind === "class"
        ? { userId: target.userId }
        : {}),
    },
  });
  return paid > 0 ? "ALREADY_PAID" : "NOT_ABANDONABLE";
}

/** Resolve the booking and prove the caller is its buyer. */
async function resolveTarget(
  appointmentId: string,
  userId: string,
): Promise<AbandonTarget | null> {
  const appt = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    select: {
      id: true,
      deletedAt: true,
      organizationId: true,
      consultation: {
        select: { id: true, requestedBy: { select: { userId: true } } },
      },
      subscription: {
        select: { id: true, requestedBy: { select: { userId: true } } },
      },
      trial: {
        select: { id: true, consulteeProfile: { select: { userId: true } } },
      },
      webinar: { select: { id: true } },
      class: { select: { id: true } },
    },
  });
  if (!appt || appt.deletedAt) return null;
  const base = {
    appointmentId: appt.id,
    userId,
    organizationId: appt.organizationId,
  };
  if (appt.consultation) {
    return appt.consultation.requestedBy.userId === userId
      ? { ...base, kind: "consultation", requestId: appt.consultation.id }
      : null;
  }
  if (appt.subscription) {
    return appt.subscription.requestedBy.userId === userId
      ? { ...base, kind: "subscription", requestId: appt.subscription.id }
      : null;
  }
  if (appt.trial) {
    return appt.trial.consulteeProfile.userId === userId
      ? { ...base, kind: "trial", requestId: appt.trial.id }
      : null;
  }
  // A seat's ownership is the caller's own participant row, which the release
  // itself scopes by userId; no seat means nothing to abandon.
  if (appt.webinar) return { ...base, kind: "webinar", requestId: null };
  if (appt.class) return { ...base, kind: "class", requestId: null };
  return null;
}

export async function abandonBooking(args: {
  appointmentId: string;
  userId: string;
}): Promise<AbandonResult> {
  const target = await resolveTarget(args.appointmentId, args.userId);
  if (!target) return { ok: false, code: "NOT_FOUND" };

  // Lock order: the appointment atom first, then the transaction (#1319), the
  // same serialisation the cancel route and every lifecycle writer take.
  //
  // The retry loop OUTLIVES the fixed 75 s grant (4 × (10 s maxWait + 15 s
  // timeout) ≈ 100 s), so each attempt re-grants it — the same per-attempt
  // renewal the approval path takes via `renewApprovalLock` (#1319). A lapsed
  // grant is not corruption: every CAS below carries its state and money
  // predicates in the WHERE, so a second abandon running concurrently matches
  // zero rows and answers NOT_ABANDONABLE / ALREADY_PAID. What it would cost is
  // the serialisation, which is the whole point of this key.
  const outcome = await withAppointmentLock(
    target.appointmentId,
    async (lock) =>
      withSerializableRetry(async () => {
        await renewAppointmentLock(lock);
        return prisma.$transaction(
          (tx): Promise<TxOutcome> => {
            const { requestId } = target;
            if (target.kind === "webinar" || target.kind === "class") {
              return abandonSeat(tx, target);
            }
            if (!requestId) {
              return Promise.resolve({ ok: false, code: "NOT_ABANDONABLE" });
            }
            return target.kind === "trial"
              ? abandonTrial(tx, { ...target, requestId })
              : abandonRequest(tx, { ...target, requestId });
          },
          {
            isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
            maxWait: 10_000,
            timeout: 15_000,
          },
        );
      }),
  );
  if (!outcome.ok) return outcome;

  // Best-effort and post-commit, as in cancel-pending: a gateway that refuses
  // to cancel never un-abandons the booking. A capture that still lands is
  // refunded by the capture-after-release path in the webhook's Phase 2.
  for (const cancel of outcome.gatewayCancels) {
    try {
      await cancelPaymentIntent(cancel.paymentIntent, cancel.gateway);
    } catch (error) {
      reportSentryError(error, {
        subsystem: "bookings",
        op: "abandon.gateway-cancel",
        expected: true,
        extra: { appointmentId: target.appointmentId },
      });
    }
  }

  return {
    ok: true,
    kind: target.kind,
    paymentsExpired: outcome.paymentsExpired,
    slotsReleased: outcome.slotsReleased,
  };
}
