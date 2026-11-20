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
import { withEventSeatLock } from "./event-seat-lock";
import { eventCheckoutHref } from "./event-waitlist";
import {
  appendSeatHistory,
  latestSeatReasons,
  REJOIN_OPENING_REASONS,
} from "./seat-history";
import { RELEASED_PARTICIPANT_STATUSES } from "./participants";

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
  removedByUserId: true,
  payment: {
    select: { paymentIntent: true, amount: true, originalAmount: true },
  },
  appointment: {
    select: {
      webinar: {
        select: {
          id: true,
          webinarPlan: { select: { id: true, title: true, price: true } },
        },
      },
      class: {
        select: {
          id: true,
          classPlan: { select: { id: true, title: true, price: true } },
        },
      },
    },
  },
} satisfies Prisma.AppointmentParticipantSelect;

/** The learner's seat on this webinar or class appointment, with what a lift needs; a 1:1 row is never a seat. */
function findLearnerSeat(
  tx: Pick<Tx, "appointmentParticipant">,
  args: { appointmentId: string; userId: string },
) {
  return tx.appointmentParticipant.findFirst({
    where: {
      appointmentId: args.appointmentId,
      userId: args.userId,
      role: "CONSULTEE",
      appointment: { appointmentType: { in: ["WEBINAR", "CLASS"] } },
    },
    select: SEAT_SELECT,
  });
}

type RemovedSeat = NonNullable<Awaited<ReturnType<typeof findLearnerSeat>>>;

/**
 * A price-free seat on an event still free rejoins through checkout; a paid or credit-funded
 * seat, or one on an event since priced (which checkout refuses to revive), needs support.
 */
function rejoinPathOf(seat: RemovedSeat): RejoinPath {
  const p = seat.payment;
  const plan =
    seat.appointment.webinar?.webinarPlan ?? seat.appointment.class?.classPlan;
  return p &&
    isPriceFreePayment({
      paymentIntent: p.paymentIntent,
      amountPaise: Number(p.amount),
      listPricePaise: Number(p.originalAmount),
    }) &&
    Number(plan?.price ?? 0) === 0
    ? "REGISTER"
    : "SUPPORT";
}

type SeatTx = Pick<Tx, "appointmentParticipant" | "bookingStatusHistory">;

/** A blocked seat: marked by a removal, or released with no leave or lift as its latest SEAT row. */
interface BlockedSeat {
  seat: RemovedSeat;
  /** False for a seat released before seat history was kept (or by a door that writes none). */
  marked: boolean;
}

/** The learner's seat when something blocks its rejoin, or null when nothing does. */
export async function readBlockedSeat(
  tx: SeatTx,
  args: { appointmentId: string; userId: string },
): Promise<BlockedSeat | null> {
  const seat = await findLearnerSeat(tx, args);
  if (!seat) return null;
  if (seat.removedByUserId) return { seat, marked: true };
  if (!RELEASED_PARTICIPANT_STATUSES.includes(seat.status)) return null;
  const latest = (await latestSeatReasons(tx, [seat.id])).get(seat.id);
  if (latest && (REJOIN_OPENING_REASONS as readonly string[]).includes(latest))
    return null;
  return { seat, marked: false };
}

/**
 * Lifts the seat's block: clears its mark by compare-and-set, or for an unmarked
 * blocked seat records the lift alone, and writes the SEAT `block_lifted` row.
 * Null when nothing blocks the seat, so a second lift changes nothing.
 */
export async function liftBlockTx(
  tx: SeatTx,
  args: {
    appointmentId: string;
    userId: string;
    actorUserId: string;
    /** Set for the organiser's door: only the mark this remover set is cleared. */
    remover?: string;
  },
): Promise<BlockedSeat | null> {
  const blocked = await readBlockedSeat(tx, args);
  if (!blocked) return null;
  const { seat } = blocked;
  if (blocked.marked) {
    const cleared = await tx.appointmentParticipant.updateMany({
      where: {
        id: seat.id,
        removedByUserId: args.remover ?? { not: null },
      },
      data: { removedByUserId: null },
    });
    if (cleared.count === 0) return null;
  }
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
  return blocked;
}

/** The webinar or class the seat belongs to, with its plan. */
function eventOf(seat: RemovedSeat) {
  const { webinar, class: cls } = seat.appointment;
  if (webinar) {
    return {
      kind: "WEBINAR" as const,
      id: webinar.id,
      plan: webinar.webinarPlan,
    };
  }
  if (cls) {
    return { kind: "CLASS" as const, id: cls.id, plan: cls.classPlan };
  }
  return null;
}

/** Stages the learner's bell on the lift's transaction, through the seat-opened event. */
async function stageRejoinBell(
  tx: Tx,
  seat: RemovedSeat,
  userId: string,
  path: RejoinPath,
  at: Date,
): Promise<StagedTrigger | null> {
  const event = eventOf(seat);
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

/** How the seat was blocked: a plain removal, a conduct removal, or a release from before seat history. */
export type BlockKind = "ORGANISER" | "CONDUCT" | "LEGACY";

export interface SeatLiftResult {
  participantId: string;
  /** Who removed the seat, as the cleared mark recorded it; null for an unmarked seat. */
  removedByUserId: string | null;
  kind: BlockKind;
  rejoinPath: RejoinPath;
  conduct: boolean;
  /** The conduct block intent this lift wrote, which the drive turns into an unblock. */
  unblockGeneration: Date | null;
  bell: StagedTrigger | null;
}

/**
 * The lift on the caller's transaction. An organiser may lift only a plain
 * removal on their own event; a conduct removal that stands, and a seat
 * released before seat history was kept, are support's to lift.
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
  const organiser = args.door === "organiser";
  if (organiser) {
    const pending = await readBlockedSeat(tx, args);
    if (pending && !pending.marked) {
      throw new BookingRuleError(
        "LIFT_NOT_ALLOWED",
        "This attendee left before seat history was kept, so support decides whether they may come back.",
        403,
      );
    }
    // An organiser lifts only a removal they made; another organiser's is theirs or support's.
    if (pending && pending.seat.removedByUserId !== args.actorUserId) {
      throw new BookingRuleError(
        "LIFT_NOT_ALLOWED",
        "Another organiser removed this attendee, so only they or support can allow them back.",
        403,
      );
    }
  }
  const blocked = await liftBlockTx(tx, {
    ...args,
    ...(organiser ? { remover: args.actorUserId } : {}),
  });
  if (!blocked) {
    throw new BookingRuleError(
      "REMOVAL_ALREADY_LIFTED",
      "This attendee is not blocked from this event, so there is nothing to lift.",
    );
  }
  const { seat } = blocked;
  let kind: BlockKind = blocked.marked ? "ORGANISER" : "LEGACY";
  if (conduct) kind = "CONDUCT";
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
    removedByUserId: seat.removedByUserId,
    kind,
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

/** The organiser's door: one Serializable transaction under the event's seat lock, then the after-commit work. */
export async function liftSeatRemovalAsOrganiser(args: {
  appointmentId: string;
  userId: string;
  actorUserId: string;
}): Promise<SeatLiftResult> {
  const lifted = await withEventSeatLock(args.appointmentId, (renew) =>
    withSerializableRetry(async () => {
      await renew();
      return prisma.$transaction(
        (tx) => liftSeatRemovalTx(tx, { ...args, door: "organiser" }),
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    }),
  );
  await afterSeatRemovalLift(args.appointmentId, args.userId, lifted);
  return lifted;
}
