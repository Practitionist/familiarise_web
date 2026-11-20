/**
 * "Request again" on a booking whose pay window closed while its order is still
 * PENDING closes the caller's old order before the new request starts, so a late
 * capture is refunded instead of confirming a second booking.
 *
 * Ownership is read before the lock. Under the appointment lock the gateway is
 * asked first, as the abandoned-payment sweep asks it: a payment it already holds
 * leaves the order PENDING for reconciliation, and an unanswered ask closes
 * nothing. Then one Serializable transaction expires the caller's orders (the
 * capture's lock order: payment, then booking), each giving back what its
 * checkout consumed, and the booking takes its lapsed state through the writer
 * its own sweep uses. Every CAS carries the money predicate, so a capture that
 * committed first makes it miss, the transaction rolls back, and the answer is
 * ALREADY_PAID with nothing closed. After the commit each closed order is read
 * once more, and a capture that landed meanwhile is refunded.
 */
import { PaymentGateway, PaymentStatus, Prisma } from "@prisma/client";

import prisma, { type Tx } from "@/lib/prisma";
import { withSerializableRetry } from "@/lib/db/serializable-retry";
import { scheduleAfter } from "@/lib/api/after-safe";
import { IllegalTransitionError } from "@/lib/enterprise/transitions";
import {
  keptCaptureWhere,
  REFUND_STATUSES_RETURNING_MONEY,
} from "@/lib/payments/webhooks/auto-refund-marker";
import {
  readRazorpayOrderHolding,
  type RazorpayOrderCancelResult,
} from "@/lib/payments/core/razorpay";
import { isPreMintIntent } from "@/lib/payments/pre-mint-intent";
import { reportSentryMessage } from "@/lib/observability/report";
import { softCancelTrialAppointmentInTx } from "@/lib/trials/cancellation";
import { cancelPaymentIntent } from "@/scripts/payments/cleanup-abandoned-payments";
import {
  renewAppointmentLock,
  withAppointmentLock,
} from "@/utils/appointmentlock";

import {
  flushBackupInterestNotices,
  stageNoticesForAppointmentHolds,
  type StagedBackupInterestNotices,
} from "./backup-interest";
import {
  finishSeatOpenedNotices,
  stageSeatOpenedNotices,
  type StagedSeatOpened,
} from "./event-waitlist";
import { lapseApprovedRequest } from "./lapse-approved-request";
import { releaseParticipant, transitionParticipant } from "./participants";
import {
  expirePendingPaymentsInTx,
  type GatewayCancel,
} from "./pending-payment-expiry";
import {
  REQUEST_AGAIN_NOTE,
  REQUESTED_AGAIN_REASON,
  type RequestAgainRefusal,
} from "./request-again-rules";
import {
  transitionConsultationRequest,
  transitionOccurrenceCompletion,
  transitionSubscriptionRequest,
  transitionTrial,
} from "./transitions";

export type RequestAgainResult =
  { ok: true; closed: number } | { ok: false; code: RequestAgainRefusal };

type RequestKind = "consultation" | "subscription";

/** Which writer ends the booking, chosen from its status in the transaction. */
type Arm =
  | { kind: "approved"; request: RequestKind; id: string }
  | { kind: "hold"; request: RequestKind; id: string }
  | { kind: "trial"; id: string }
  | { kind: "seat" }
  | { kind: "none" };

type TxOutcome =
  | { ok: false; code: RequestAgainRefusal }
  | {
      ok: true;
      closed: number;
      closedOrders: GatewayCancel[];
      holdNotices?: StagedBackupInterestNotices | null;
      seatOpened?: StagedSeatOpened | null;
    };

/** A CAS that missed after the orders expired: thrown so the whole transaction rolls back. */
class LostToCapture extends Error {}

const NO_CAPTURE = {
  payment: { none: { paymentStatus: PaymentStatus.SUCCEEDED } },
} as const;

type OwnedRequest = {
  id: string;
  status: string;
  bookingSource: string;
  requestedBy: { userId: string };
};

/** A request's arm: only an approval awaiting payment or a pay-first hold, never one under an open move. */
function requestArm(
  row: OwnedRequest,
  request: RequestKind,
  userId: string,
  moving: boolean,
): Arm | null {
  if (row.requestedBy.userId !== userId) return null;
  if (moving) return { kind: "none" };
  if (row.status === "APPROVED_PENDING_PAYMENT")
    return { kind: "approved", request, id: row.id };
  if (row.status === "PENDING" && row.bookingSource === "DIRECT_CHECKOUT")
    return { kind: "hold", request, id: row.id };
  return { kind: "none" };
}

/** The booking as the caller owns it, or null when it is not theirs. */
async function readOwnedArm(
  db: Pick<Tx, "appointment">,
  appointmentId: string,
  userId: string,
): Promise<Arm | null> {
  const request = {
    select: {
      id: true,
      status: true,
      bookingSource: true,
      requestedBy: { select: { userId: true } },
    },
  } as const;
  const appt = await db.appointment.findUnique({
    where: { id: appointmentId },
    select: {
      consultation: request,
      subscription: request,
      trial: {
        select: {
          id: true,
          status: true,
          consulteeProfile: { select: { userId: true } },
        },
      },
      webinarId: true,
      classId: true,
      participants: {
        where: { userId, role: "CONSULTEE" },
        select: { id: true },
        take: 1,
      },
      rescheduleRequests: {
        where: { openForAppointmentId: appointmentId },
        select: { id: true },
        take: 1,
      },
    },
  });
  if (!appt) return null;
  const moving = appt.rescheduleRequests.length > 0;
  if (appt.consultation)
    return requestArm(appt.consultation, "consultation", userId, moving);
  if (appt.subscription)
    return requestArm(appt.subscription, "subscription", userId, moving);
  if (appt.trial) {
    if (appt.trial.consulteeProfile.userId !== userId) return null;
    return appt.trial.status === "AWAITING_PAYMENT"
      ? { kind: "trial", id: appt.trial.id }
      : { kind: "none" };
  }
  if (appt.webinarId || appt.classId) {
    return appt.participants.length > 0 ? { kind: "seat" } : null;
  }
  return null;
}

/** A pay-first hold ends as the abandoned-payment pass ends it: EXPIRED, released, tombstoned. */
async function expireHold(
  tx: Tx,
  arm: { request: RequestKind; id: string },
  appointmentId: string,
  userId: string,
  now: Date,
): Promise<StagedBackupInterestNotices | null> {
  const meta = {
    actorUserId: userId,
    reason: REQUESTED_AGAIN_REASON,
    appointmentId,
    to: "EXPIRED" as const,
    fromIn: ["PENDING" as const],
  };
  if (arm.request === "consultation") {
    await transitionConsultationRequest(tx, {
      ...meta,
      where: { id: arm.id, appointment: NO_CAPTURE },
    });
  } else {
    await transitionSubscriptionRequest(tx, {
      ...meta,
      where: { id: arm.id, appointment: NO_CAPTURE },
    });
  }
  // Read before the release below stops these times counting as held.
  const holdNotices = await stageNoticesForAppointmentHolds(tx, appointmentId);
  await transitionOccurrenceCompletion(tx, {
    actorUserId: userId,
    reason: REQUESTED_AGAIN_REASON,
    where: { appointmentId, deletedAt: null },
    to: "CANCELLED",
    data: { deletedAt: now },
    allowZero: true,
  });
  await transitionParticipant(tx, { appointmentId }, "CANCELLED", {
    fromIn: ["HELD"],
  });
  await tx.appointment.updateMany({
    where: { id: appointmentId, deletedAt: null },
    data: { deletedAt: now },
  });
  return holdNotices;
}

/** The booking takes its lapsed state; a miss means a capture got there first. */
async function endBooking(
  tx: Tx,
  arm: Exclude<Arm, { kind: "none" }>,
  appointmentId: string,
  userId: string,
  now: Date,
): Promise<{
  holdNotices?: StagedBackupInterestNotices | null;
  seatOpened?: StagedSeatOpened | null;
}> {
  switch (arm.kind) {
    case "approved": {
      const out = await lapseApprovedRequest(tx, {
        kind: arm.request,
        id: arm.id,
        reason: REQUESTED_AGAIN_REASON,
        actorUserId: userId,
      });
      if (out.moved === 0) throw new LostToCapture();
      return { holdNotices: out.holdNotices };
    }
    case "hold":
      return {
        holdNotices: await expireHold(tx, arm, appointmentId, userId, now),
      };
    case "trial": {
      await transitionTrial(tx, {
        actorUserId: userId,
        reason: REQUESTED_AGAIN_REASON,
        where: { id: arm.id },
        to: "CANCELLED",
        fromIn: ["AWAITING_PAYMENT"],
        // The capture stamps paymentId; the appointment arm catches a late stamp.
        whereAnd: {
          paymentId: null,
          NOT: {
            appointment: {
              is: { payment: { some: { paymentStatus: "SUCCEEDED" } } },
            },
          },
        },
        data: { pendingPaymentUrl: null, paymentDueAt: null },
      });
      // Read before the release below stops these times counting as held.
      const holdNotices = await stageNoticesForAppointmentHolds(
        tx,
        appointmentId,
      );
      await softCancelTrialAppointmentInTx(tx, appointmentId);
      return { holdNotices };
    }
    case "seat": {
      const released = await releaseParticipant(tx, {
        appointmentId,
        userId,
        role: "CONSULTEE",
        status: "HELD",
        NOT: { payment: { is: { paymentStatus: "SUCCEEDED" } } },
      });
      if (released === 0) throw new LostToCapture();
      return {
        seatOpened: await stageSeatOpenedNotices(tx, appointmentId, now),
      };
    }
  }
}

/** True when a capture of the caller's is kept for this booking and not wholly refunded. */
async function holdsCapture(
  db: Pick<Tx, "payment">,
  appointmentId: string,
  userId: string,
): Promise<boolean> {
  const paid = await db.payment.findMany({
    where: {
      appointmentId,
      userId,
      paymentStatus: PaymentStatus.SUCCEEDED,
      ...keptCaptureWhere,
    },
    select: {
      amount: true,
      refunds: {
        where: { status: { in: REFUND_STATUSES_RETURNING_MONEY } },
        select: { amountPaise: true },
      },
    },
  });
  return paid.some(
    (p) =>
      p.refunds.reduce((sum, r) => sum + Number(r.amountPaise), 0) <
      Number(p.amount),
  );
}

type GatewayCheck =
  | { ok: true; cleared: ReadonlySet<string> }
  | { ok: false; code: "PAYMENT_IN_PROGRESS" | "GATEWAY_UNCHECKED" };

/** What the gateway answers for one order; a cancel that threw is unproven. */
async function askGateway(order: {
  paymentIntent: string;
  paymentGateway: PaymentGateway;
}): Promise<RazorpayOrderCancelResult> {
  try {
    return await cancelPaymentIntent(order.paymentIntent, order.paymentGateway);
  } catch {
    return "unknown";
  }
}

/**
 * The abandoned-payment sweep's rule: an order expires only once its gateway
 * holds no live payment. A live one stays PENDING for reconciliation to confirm
 * or refund; an unproven answer closes nothing.
 */
async function checkGateway(
  appointmentId: string,
  userId: string,
): Promise<GatewayCheck> {
  const orders = await prisma.payment.findMany({
    where: { appointmentId, userId, paymentStatus: PaymentStatus.PENDING },
    select: {
      id: true,
      paymentIntent: true,
      paymentGateway: true,
      isMockPayment: true,
    },
  });
  const cleared = new Set<string>();
  for (const order of orders) {
    const answer = order.isMockPayment
      ? "no_live_payment"
      : await askGateway(order);
    if (answer === "has_live_payment")
      return { ok: false, code: "PAYMENT_IN_PROGRESS" };
    if (answer !== "no_live_payment")
      return { ok: false, code: "GATEWAY_UNCHECKED" };
    cleared.add(order.id);
  }
  return { ok: true, cleared };
}

async function closeInTx(
  tx: Tx,
  appointmentId: string,
  userId: string,
  now: Date,
  cleared: ReadonlySet<string>,
): Promise<TxOutcome> {
  const arm = await readOwnedArm(tx, appointmentId, userId);
  if (!arm) return { ok: false, code: "NOT_FOUND" };
  const pending = await tx.payment.findMany({
    where: { appointmentId, userId, paymentStatus: PaymentStatus.PENDING },
    select: { id: true, expiresAt: true },
  });
  // Nothing open: already closed (a second click, or the sweep), or paid.
  if (pending.length === 0) {
    return (await holdsCapture(tx, appointmentId, userId))
      ? { ok: false, code: "ALREADY_PAID" }
      : { ok: true, closed: 0, closedOrders: [] };
  }
  if (pending.some((p) => p.expiresAt === null || p.expiresAt > now)) {
    return { ok: false, code: "PAY_WINDOW_OPEN" };
  }
  // A booking in another state, or an order the gateway was not asked about.
  if (arm.kind === "none" || pending.some((p) => !cleared.has(p.id)))
    return { ok: false, code: "NOT_CLOSABLE" };

  const { expired, gatewayCancels } = await expirePendingPaymentsInTx(tx, {
    appointmentId,
    userId,
    reason: REQUEST_AGAIN_NOTE,
  });
  if (expired === 0) throw new LostToCapture();
  const notices = await endBooking(tx, arm, appointmentId, userId, now);
  return {
    ok: true,
    closed: expired,
    closedOrders: gatewayCancels,
    ...notices,
  };
}

/**
 * A capture can land between the gateway check and the commit. Each closed order
 * is read once more; a capture found goes through `handlePaymentSuccess`, whose
 * EXPIRED arm refunds it, so a later webhook or reconcile changes nothing more.
 * Never undoes the close; unread orders are reported once per click.
 */
async function recheckClosedOrders(
  orders: readonly GatewayCancel[],
  appointmentId: string,
): Promise<void> {
  const unread: string[] = [];
  for (const order of orders) {
    if (
      order.gateway !== PaymentGateway.RAZORPAY ||
      isPreMintIntent(order.paymentIntent)
    )
      continue;
    try {
      const holding = await readRazorpayOrderHolding(order.paymentIntent);
      if (holding.kind !== "captured") continue;
      // Dynamic, as the recover door imports it: the capture handlers reach back into booking.
      const { handlePaymentSuccess } =
        await import("@/lib/payments/webhooks/handlers");
      await handlePaymentSuccess(
        order.paymentIntent,
        {},
        holding.amountPaise,
        holding.paymentId,
      );
    } catch {
      unread.push(order.paymentIntent);
    }
  }
  if (unread.length === 0) return;
  reportSentryMessage(
    `REQUEST_AGAIN_RECHECK_FAILED: ${unread.length} closed order(s) not re-read`,
    {
      subsystem: "bookings",
      level: "warning",
      extra: { appointmentId, orderIds: unread },
    },
  );
}

export async function closeOrderForRequestAgain(args: {
  appointmentId: string;
  userId: string;
}): Promise<RequestAgainResult> {
  const { appointmentId, userId } = args;
  const now = new Date();
  // Before the lock, so a stranger's answer never depends on who else holds it.
  const owned = await readOwnedArm(prisma, appointmentId, userId);
  if (!owned) return { ok: false, code: "NOT_FOUND" };
  let outcome: TxOutcome;
  try {
    outcome = await withAppointmentLock(appointmentId, async (lock) => {
      const gateway = await checkGateway(appointmentId, userId);
      if (!gateway.ok) return gateway;
      // The retry loop outlives the lock grant, so each attempt re-grants it.
      return withSerializableRetry(async () => {
        await renewAppointmentLock(lock);
        return prisma.$transaction(
          (tx) => closeInTx(tx, appointmentId, userId, now, gateway.cleared),
          {
            isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
            maxWait: 10_000,
            timeout: 15_000,
          },
        );
      });
    });
  } catch (error) {
    if (
      !(error instanceof LostToCapture) &&
      !(error instanceof IllegalTransitionError)
    )
      throw error;
    // Rolled back: nothing was closed. Say why from what committed instead.
    return (await holdsCapture(prisma, appointmentId, userId))
      ? { ok: false, code: "ALREADY_PAID" }
      : { ok: false, code: "NOT_CLOSABLE" };
  }
  if (!outcome.ok) return outcome;
  const { closed, closedOrders, holdNotices, seatOpened } = outcome;

  await recheckClosedOrders(closedOrders, appointmentId);

  await flushBackupInterestNotices(holdNotices);
  await scheduleAfter(
    () => finishSeatOpenedNotices(seatOpened),
    "request-again.seat-opened",
  );
  return { ok: true, closed };
}
