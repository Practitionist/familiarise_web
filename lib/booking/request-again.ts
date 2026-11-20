/**
 * "Request again" on a booking whose pay window closed while its order is still
 * PENDING closes the caller's old order before the new request starts, so a late
 * capture is refunded instead of confirming a second booking.
 *
 * One Serializable transaction under the appointment lock. The caller's PENDING
 * orders expire first (the capture's lock order: payment, then booking), each
 * giving back what its checkout consumed; then the booking takes its lapsed state
 * through the writer its own sweep uses. Every CAS carries the money predicate, so
 * a capture that committed first makes it miss, the transaction rolls back, and
 * the answer is ALREADY_PAID with nothing closed. Gateway cancels run after commit.
 */
import { PaymentStatus, Prisma } from "@prisma/client";

import prisma, { type Tx } from "@/lib/prisma";
import { withSerializableRetry } from "@/lib/db/serializable-retry";
import { scheduleAfter } from "@/lib/api/after-safe";
import { IllegalTransitionError } from "@/lib/enterprise/transitions";
import { unreturnedCaptureWhere } from "@/lib/payments/webhooks/auto-refund-marker";
import { softCancelTrialAppointmentInTx } from "@/lib/trials/cancellation";
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
  cancelGatewayOrders,
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
      gatewayCancels: GatewayCancel[];
      holdNotices?: StagedBackupInterestNotices | null;
      seatOpened?: StagedSeatOpened | null;
    };

/** A CAS that missed after the orders expired: thrown so the whole transaction rolls back. */
class LostToCapture extends Error {}

const NO_CAPTURE = {
  payment: { none: { paymentStatus: PaymentStatus.SUCCEEDED } },
} as const;

/** The booking as the caller owns it, or null when it is not theirs. */
async function readOwnedArm(
  tx: Tx,
  appointmentId: string,
  userId: string,
): Promise<Arm | null> {
  const request = {
    select: {
      id: true,
      status: true,
      requestedBy: { select: { userId: true } },
    },
  } as const;
  const appt = await tx.appointment.findUnique({
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
    },
  });
  if (!appt) return null;
  const row = appt.consultation ?? appt.subscription;
  if (row) {
    if (row.requestedBy.userId !== userId) return null;
    const kind: RequestKind = appt.consultation
      ? "consultation"
      : "subscription";
    if (row.status === "APPROVED_PENDING_PAYMENT")
      return { kind: "approved", request: kind, id: row.id };
    if (row.status === "PENDING")
      return { kind: "hold", request: kind, id: row.id };
    return { kind: "none" };
  }
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
    case "trial":
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
      await softCancelTrialAppointmentInTx(tx, appointmentId);
      return {};
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

/** True when a capture of the caller's on this booking still holds its money. */
async function holdsCapture(
  db: Pick<Tx, "payment">,
  appointmentId: string,
  userId: string,
): Promise<boolean> {
  const paid = await db.payment.count({
    where: {
      appointmentId,
      userId,
      paymentStatus: PaymentStatus.SUCCEEDED,
      ...unreturnedCaptureWhere,
    },
  });
  return paid > 0;
}

async function closeInTx(
  tx: Tx,
  appointmentId: string,
  userId: string,
  now: Date,
): Promise<TxOutcome> {
  const arm = await readOwnedArm(tx, appointmentId, userId);
  if (!arm) return { ok: false, code: "NOT_FOUND" };
  const pending = await tx.payment.findMany({
    where: { appointmentId, userId, paymentStatus: PaymentStatus.PENDING },
    select: { expiresAt: true },
  });
  // Nothing open: already closed (a second click, or the sweep), or paid.
  if (pending.length === 0) {
    return (await holdsCapture(tx, appointmentId, userId))
      ? { ok: false, code: "ALREADY_PAID" }
      : { ok: true, closed: 0, gatewayCancels: [] };
  }
  if (pending.some((p) => p.expiresAt === null || p.expiresAt > now)) {
    return { ok: false, code: "PAY_WINDOW_OPEN" };
  }
  if (arm.kind === "none") return { ok: false, code: "NOT_CLOSABLE" };

  const { expired, gatewayCancels } = await expirePendingPaymentsInTx(tx, {
    appointmentId,
    userId,
    reason: REQUEST_AGAIN_NOTE,
  });
  if (expired === 0) throw new LostToCapture();
  const notices = await endBooking(tx, arm, appointmentId, userId, now);
  return { ok: true, closed: expired, gatewayCancels, ...notices };
}

export async function closeOrderForRequestAgain(args: {
  appointmentId: string;
  userId: string;
}): Promise<RequestAgainResult> {
  const { appointmentId, userId } = args;
  const now = new Date();
  let outcome: TxOutcome;
  try {
    // The retry loop outlives the lock grant, so each attempt re-grants it.
    outcome = await withAppointmentLock(appointmentId, async (lock) =>
      withSerializableRetry(async () => {
        await renewAppointmentLock(lock);
        return prisma.$transaction(
          (tx) => closeInTx(tx, appointmentId, userId, now),
          {
            isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
            maxWait: 10_000,
            timeout: 15_000,
          },
        );
      }),
    );
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
  const { closed, gatewayCancels, holdNotices, seatOpened } = outcome;

  await flushBackupInterestNotices(holdNotices);
  await scheduleAfter(
    () => finishSeatOpenedNotices(seatOpened),
    "request-again.seat-opened",
  );
  await cancelGatewayOrders(gatewayCancels, {
    op: "request-again.gateway-cancel",
    appointmentId,
  });
  return { ok: true, closed };
}
