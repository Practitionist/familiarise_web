/**
 * Lifting a removal: the seat's `removedByUserId` is cleared by compare-and-set
 * and a SEAT `block_lifted` row is written. It never re-seats anyone and never
 * records a support decision; the learner registers again through checkout.
 */

import { Prisma } from "@prisma/client";

import prisma, { type Tx } from "@/lib/prisma";
import { withSerializableRetry } from "@/lib/db/serializable-retry";
import { isPriceFreePayment } from "@/lib/payments/funding-rail";
import { NOVU_WORKFLOWS } from "@/lib/novu/workflows";
import { stageBell } from "@/lib/novu/stage-bell";
import { flushNotificationsAfter } from "@/lib/novu/stage-then-attempt";
import type { StagedTrigger } from "@/lib/novu/outbox";
import { getAppUrl } from "@/lib/url";
import { conductRemovalStands } from "@/lib/support/conduct-removal-state";
import {
  persistConductBlockInTx,
  syncConductCallBlock,
} from "@/lib/stream/access-revocation";
import { BookingRuleError } from "./booking-rule-error";
import { eventCheckoutHref } from "./event-waitlist";
import { appendSeatHistory } from "./seat-history";

/** What the learner may do once the block is lifted: register themselves, or ask support. */
export type RejoinPath = "REGISTER" | "SUPPORT";

/** The sentence the learner reads for each path; the bell template renders the same words. */
export function rejoinNoticeText(path: RejoinPath, eventTitle: string): string {
  return path === "REGISTER"
    ? `You can register for ${eventTitle} again.`
    : `Support will help you rejoin ${eventTitle}.`;
}

const SEAT_SELECT = {
  id: true,
  status: true,
  appointmentId: true,
  payment: {
    select: { paymentIntent: true, amount: true, originalAmount: true },
  },
  appointment: {
    select: {
      webinar: {
        select: {
          id: true,
          webinarPlan: { select: { id: true, title: true } },
        },
      },
      class: {
        select: {
          id: true,
          classPlan: { select: { id: true, title: true } },
        },
      },
    },
  },
} satisfies Prisma.AppointmentParticipantSelect;

/** The removed learner seat on this appointment, or null when it carries no mark. */
function findRemovedSeat(
  tx: Pick<Tx, "appointmentParticipant">,
  args: { appointmentId: string; userId: string },
) {
  return tx.appointmentParticipant.findFirst({
    where: {
      appointmentId: args.appointmentId,
      userId: args.userId,
      role: "CONSULTEE",
      removedByUserId: { not: null },
    },
    select: SEAT_SELECT,
  });
}

type RemovedSeat = NonNullable<Awaited<ReturnType<typeof findRemovedSeat>>>;

/** A price-free seat rejoins through checkout; a paid or credit-funded one needs support. */
function rejoinPathOf(seat: RemovedSeat): RejoinPath {
  const p = seat.payment;
  return p &&
    isPriceFreePayment({
      paymentIntent: p.paymentIntent,
      amountPaise: Number(p.amount),
      listPricePaise: Number(p.originalAmount),
    })
    ? "REGISTER"
    : "SUPPORT";
}

/**
 * Clears the removal mark by compare-and-set and writes its SEAT row. Null when
 * the seat carries no mark, so a second lift or an overturn after a lift changes nothing.
 */
export async function clearRemovalMarkTx(
  tx: Pick<Tx, "appointmentParticipant" | "bookingStatusHistory">,
  args: { appointmentId: string; userId: string; actorUserId: string },
): Promise<RemovedSeat | null> {
  const seat = await findRemovedSeat(tx, args);
  if (!seat) return null;
  const cleared = await tx.appointmentParticipant.updateMany({
    where: { id: seat.id, removedByUserId: { not: null } },
    data: { removedByUserId: null },
  });
  if (cleared.count === 0) return null;
  await appendSeatHistory(
    tx,
    [
      {
        participantId: seat.id,
        appointmentId: seat.appointmentId,
        fromStatus: seat.status,
        toStatus: seat.status,
      },
    ],
    { reason: "block_lifted", actorUserId: args.actorUserId },
  );
  return seat;
}

/** Stages the learner's bell on the lift's transaction, through the seat-opened event. */
async function stageRejoinBell(
  tx: Tx,
  seat: RemovedSeat,
  userId: string,
  path: RejoinPath,
  at: Date,
): Promise<StagedTrigger | null> {
  const event = seat.appointment.webinar
    ? {
        kind: "WEBINAR" as const,
        id: seat.appointment.webinar.id,
        plan: seat.appointment.webinar.webinarPlan,
      }
    : seat.appointment.class
      ? {
          kind: "CLASS" as const,
          id: seat.appointment.class.id,
          plan: seat.appointment.class.classPlan,
        }
      : null;
  if (!event) return null;
  return stageBell(tx, {
    workflowId: NOVU_WORKFLOWS.EVENT_SEAT_OPENED,
    recipients: [userId],
    payload: {
      planTitle: event.plan.title,
      eventLabel: event.kind === "CLASS" ? "class" : "webinar",
      rejoinText: rejoinNoticeText(path, event.plan.title),
      checkoutUrl:
        path === "REGISTER"
          ? eventCheckoutHref(event.kind, event.plan.id, event.id)
          : `${getAppUrl()}/dashboard/support`,
    },
    dedupeKey: `seat-lifted:${seat.id}:${at.getTime()}`,
    entityRef: `appointment:${seat.appointmentId}`,
  });
}

export interface SeatLiftResult {
  participantId: string;
  rejoinPath: RejoinPath;
  conduct: boolean;
  /** The conduct block intent this lift wrote, which the drive turns into an unblock. */
  unblockGeneration: Date | null;
  bell: StagedTrigger | null;
}

/**
 * The lift on the caller's transaction. An organiser may lift only a plain
 * removal on their own event; a conduct removal that stands is support's to lift.
 */
export async function liftSeatRemovalTx(
  tx: Tx,
  args: {
    appointmentId: string;
    userId: string;
    actorUserId: string;
    door: "staff" | "organiser";
  },
): Promise<SeatLiftResult> {
  // Read before the mark is cleared, which ends the removal standing.
  const conduct = await conductRemovalStands(
    args.appointmentId,
    args.userId,
    tx,
  );
  if (conduct && args.door === "organiser") {
    throw new BookingRuleError(
      "LIFT_NOT_ALLOWED",
      "This attendee was removed for conduct, so support reviews whether they may come back.",
      403,
    );
  }
  const seat = await clearRemovalMarkTx(tx, args);
  if (!seat) {
    throw new BookingRuleError(
      "REMOVAL_ALREADY_LIFTED",
      "This attendee is not blocked from this event, so there is nothing to lift.",
    );
  }
  // A lifted conduct removal no longer stands, so the drive unblocks the calls.
  const unblockGeneration = conduct
    ? await persistConductBlockInTx(tx, args.appointmentId, args.userId)
    : null;
  const rejoinPath = rejoinPathOf(seat);
  const bell = await stageRejoinBell(
    tx,
    seat,
    args.userId,
    rejoinPath,
    new Date(),
  );
  return {
    participantId: seat.id,
    rejoinPath,
    conduct,
    unblockGeneration,
    bell,
  };
}

/** After the lift commits: drive the unblock and ring the bell. Never throws past its own reports. */
export async function afterSeatRemovalLift(
  appointmentId: string,
  userId: string,
  lifted: SeatLiftResult,
): Promise<void> {
  if (lifted.unblockGeneration) {
    await syncConductCallBlock(appointmentId, userId, lifted.unblockGeneration);
  }
  await flushNotificationsAfter({ bells: [lifted.bell] }, "seat-removal.lift");
}

/** The organiser's door: one Serializable transaction, then the after-commit work. */
export async function liftSeatRemovalAsOrganiser(args: {
  appointmentId: string;
  userId: string;
  actorUserId: string;
}): Promise<SeatLiftResult> {
  const lifted = await withSerializableRetry(() =>
    prisma.$transaction(
      (tx) => liftSeatRemovalTx(tx, { ...args, door: "organiser" }),
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
  await afterSeatRemovalLift(args.appointmentId, args.userId, lifted);
  return lifted;
}
