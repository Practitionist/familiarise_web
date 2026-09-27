/**
 * #1780 row 4 — the host cancels ONE session of a class series.
 *
 * The session is made up within 14 days (a new occurrence with the same
 * ordinal, held by the day-14 deadline) or every seat that held it is
 * refunded one unit by the settle sweep. A cancelled session keeps no
 * `deletedAt`, so it stays countable: every host cancellation is a miss, made
 * up or not, and three misses (or a quarter of the series) give the learners
 * the right to leave with every undelivered session refunded.
 */

import { OccurrenceCompletionStatus, Prisma } from "@prisma/client";
import { format } from "date-fns";

import prisma, { type Tx } from "@/lib/prisma";
import { transitionOccurrenceCompletion } from "@/lib/booking/transitions";
import { recordSystemError } from "@/lib/enterprise/system-events";
import { recomputeEarningsHold } from "@/lib/payments/payouts/earnings-hold";
import {
  fundingRailForIntent,
  refundBookingPayment,
} from "@/lib/payments/operations/booking-refund";
import {
  findDedupedRefund,
  RefundValidationError,
} from "@/lib/payments/operations/refund";
import { NOVU_WORKFLOWS } from "@/lib/novu/workflows";
import { stageBell } from "@/lib/novu/stage-bell";
import { goHref } from "@/lib/dashboard/go";
import { withAppointmentLock } from "@/utils/appointmentlock";
import { OpsRefusal } from "@/lib/backoffice/ops-refusal-error";
import { BookingRuleError } from "./booking-rule-error";
import { MAKEUP_WINDOW_DAYS, MISS_WHERE, missedAt } from "./misses";
import {
  exitRightFor,
  seatLedger,
  seriesLedger,
  type SeriesLedger,
} from "./class-series";

// Lives with the miss predicates so light readers (Home, #1527) skip this module.
export { MAKEUP_WINDOW_DAYS };
const DAY_MS = 86_400_000;

/** The dedupe key of one seat's refund for one missed session. */
export const occurrenceRefundKey = (occurrenceId: string, paymentId: string) =>
  `occ:${occurrenceId}:pay:${paymentId}`;

const isMiss = (o: {
  completionStatus: OccurrenceCompletionStatus;
  hostCancelledAt: Date | null;
  voidedAt: Date | null;
}) =>
  (o.completionStatus === OccurrenceCompletionStatus.CANCELLED &&
    !!o.hostCancelledAt) ||
  (o.completionStatus === OccurrenceCompletionStatus.VOIDED && !!o.voidedAt);

const SEATED: Prisma.AppointmentParticipantWhereInput = {
  role: "CONSULTEE",
  status: { in: ["CONFIRMED", "ATTENDED"] },
};

const when = (d: Date) => format(d, "EEE d MMM yyyy, HH:mm 'UTC'");

export interface ClassActor {
  userId: string;
  consultantProfileId: string | null;
  isPrivileged: boolean;
}

const HOSTED_CLASS_SELECT = {
  id: true,
  organizationId: true,
  class: {
    select: {
      id: true,
      classPlan: {
        select: {
          title: true,
          consultantProfileId: true,
          consultantProfile: {
            select: { user: { select: { name: true } } },
          },
        },
      },
    },
  },
} satisfies Prisma.AppointmentSelect;

/** The class behind an appointment, and whether this actor hosts it. */
export async function readHostedClass(
  appointmentId: string,
  actor: ClassActor,
) {
  const appointment = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    select: HOSTED_CLASS_SELECT,
  });
  const cls = appointment?.class;
  if (!appointment || !cls) return { found: false as const };
  const isHost =
    actor.isPrivileged ||
    (!!actor.consultantProfileId &&
      cls.classPlan.consultantProfileId === actor.consultantProfileId);
  return { found: true as const, isHost, appointment, cls };
}

export type HostedClass = Extract<
  Awaited<ReturnType<typeof readHostedClass>>,
  { found: true }
>;

/**
 * #1771 — whether the reliability flag is due: never flagged, or the latest
 * event is an ops clear and a host-attributed miss came after it. An active
 * flag is never repeated. The caller has already checked the miss threshold.
 */
export function reliabilityFlagDue(
  latest: { createdAt: Date; context: unknown } | null,
  lastMissAt: Date,
): boolean {
  if (!latest) return true;
  const cleared =
    (latest.context as { cleared?: unknown } | null)?.cleared === true;
  return cleared && lastMissAt > latest.createdAt;
}

/**
 * The reliability flag when due, and the exit-right bells when the right first
 * trips. #1569 D6 — every miss counts toward the learner's exit right; only a
 * host-attributed one (a cancel, CUT_SHORT, HOST_ABSENT) can raise the flag.
 */
async function onExitRightTripped(
  tx: Tx,
  hosted: HostedClass,
  ledger: SeriesLedger,
  seatUserIds: string[],
  opts: { missedAt: Date; hostAttributed: boolean; firstTrip: boolean },
): Promise<void> {
  const correlationId = `class-reliability:${hosted.cls.id}`;
  if (opts.hostAttributed && exitRightFor(ledger.hostMisses, ledger.N)) {
    const latest = await tx.systemEvent.findFirst({
      where: { correlationId },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true, context: true },
    });
    if (reliabilityFlagDue(latest, opts.missedAt)) {
      await recordSystemError({
        organizationId: hosted.appointment.organizationId,
        category: "BOOKING",
        summary: `Class ${hosted.cls.id} reached the learner exit right`,
        err: new Error("CLASS_RELIABILITY"),
        context: {
          consultantProfileId: hosted.cls.classPlan.consultantProfileId,
          misses: ledger.hostMisses,
          N: ledger.N,
        },
        correlationId,
        db: tx,
      });
    }
  }
  if (!opts.firstTrip) return;
  const misses = ledger.misses;
  for (const userId of seatUserIds) {
    await stageBell(tx, {
      workflowId: NOVU_WORKFLOWS.CLASS_EXIT_AVAILABLE,
      recipients: [userId],
      payload: {
        planTitle: hosted.cls.classPlan.title,
        misses,
        // #1527 — every seat holder here is a consultee.
        dashboardUrl: goHref("client", "appointments"),
      },
      dedupeKey: `exit-avail:${hosted.cls.id}:${userId}`,
    });
  }
}

/** E-2 — cancel one future session; no deletedAt, so it stays a miss. */
export async function cancelClassSession(
  hosted: HostedClass,
  occurrenceId: string,
) {
  const appointmentId = hosted.appointment.id;
  return withAppointmentLock(appointmentId, () =>
    prisma.$transaction(async (tx) => {
      const now = new Date();
      const moved = await transitionOccurrenceCompletion(tx, {
        where: {
          id: occurrenceId,
          appointmentId,
          startsAt: { gt: now },
          isTentative: false,
        },
        to: OccurrenceCompletionStatus.CANCELLED,
        fromIn: [OccurrenceCompletionStatus.SCHEDULED],
        data: { hostCancelledAt: now },
        reason: "HOST_CANCELLED_SESSION",
        allowZero: true,
      });
      if (moved === 0) {
        throw new BookingRuleError(
          "SESSION_NOT_CANCELLABLE",
          "This session can no longer be cancelled — it has started, finished or was already cancelled.",
        );
      }
      const session = await tx.appointmentOccurrence.findUniqueOrThrow({
        where: { id: occurrenceId },
        select: { startsAt: true },
      });
      const makeUpBy = new Date(now.getTime() + MAKEUP_WINDOW_DAYS * DAY_MS);
      const seats = await tx.appointmentParticipant.findMany({
        where: { appointmentId, ...SEATED },
        select: { userId: true },
      });
      const seatUserIds = seats.map((s) => s.userId);
      if (seatUserIds.length > 0) {
        await stageBell(tx, {
          workflowId: NOVU_WORKFLOWS.CLASS_SESSION_CANCELLED,
          recipients: seatUserIds,
          payload: {
            planTitle: hosted.cls.classPlan.title,
            consultantName:
              hosted.cls.classPlan.consultantProfile?.user.name ?? "Your host",
            dateTime: when(session.startsAt),
            makeUpBy: when(makeUpBy),
            // #1527 — every seat holder here is a consultee.
            dashboardUrl: goHref("client", "appointments"),
          },
          dedupeKey: `occ-cancel:${occurrenceId}`,
        });
      }
      const ledger = await seriesLedger(tx, appointmentId, now);
      // Past the threshold every miss re-checks the flag (an ops clear may
      // precede it); the learners' bells go out only on the first trip.
      if (ledger.exitRight) {
        await onExitRightTripped(tx, hosted, ledger, seatUserIds, {
          missedAt: now,
          hostAttributed: true,
          firstTrip: !exitRightFor(ledger.misses - 1, ledger.N),
        });
      }
      return {
        occurrenceId,
        hostCancelledAt: now,
        makeUpBy,
        misses: ledger.misses,
        exitRight: ledger.exitRight,
      };
    }),
  );
}

/**
 * #1569 — the outcome sweep voided one class session, inside its transaction:
 * the seats hear their make-up window (the cancel bell's voided variant), and
 * the exit right is re-checked because a void is a miss.
 */
export async function onClassSessionVoided(
  tx: Tx,
  args: {
    appointmentId: string;
    occurrenceId: string;
    startsAt: Date;
    voidedAt: Date;
    hostAttributed: boolean;
  },
): Promise<void> {
  const appointment = await tx.appointment.findUnique({
    where: { id: args.appointmentId },
    select: HOSTED_CLASS_SELECT,
  });
  const cls = appointment?.class;
  if (!appointment || !cls) return;
  const hosted: HostedClass = {
    found: true,
    isHost: false,
    appointment,
    cls,
  };
  const seats = await tx.appointmentParticipant.findMany({
    where: { appointmentId: args.appointmentId, ...SEATED },
    select: { userId: true },
  });
  const seatUserIds = seats.map((s) => s.userId);
  if (seatUserIds.length > 0) {
    await stageBell(tx, {
      workflowId: NOVU_WORKFLOWS.CLASS_SESSION_CANCELLED,
      recipients: seatUserIds,
      payload: {
        voided: true,
        planTitle: cls.classPlan.title,
        consultantName:
          cls.classPlan.consultantProfile?.user.name ?? "Your host",
        dateTime: when(args.startsAt),
        makeUpBy: when(
          new Date(args.voidedAt.getTime() + MAKEUP_WINDOW_DAYS * DAY_MS),
        ),
        // #1527 — every seat holder here is a consultee.
        dashboardUrl: goHref("client", "appointments"),
      },
      dedupeKey: `occ-void:${args.occurrenceId}`,
    });
  }
  const ledger = await seriesLedger(tx, args.appointmentId, args.voidedAt);
  if (ledger.exitRight) {
    await onExitRightTripped(tx, hosted, ledger, seatUserIds, {
      missedAt: args.voidedAt,
      hostAttributed: args.hostAttributed,
      firstTrip: !exitRightFor(ledger.misses - 1, ledger.N),
    });
  }
}

/** E-3 — schedule the make-up: same ordinal, held within 14 days. */
export async function scheduleClassMakeUp(
  hosted: HostedClass,
  sourceOccurrenceId: string,
  startsAt: Date,
  /** #1771 K-6 — an operator may hold it past day 14, never without a reason. */
  opts: { bypassWindow?: { opsActorUserId: string; reason: string } } = {},
) {
  const bypass = opts.bypassWindow;
  if (bypass && bypass.reason.trim().length < 5) {
    throw new OpsRefusal(
      "BYPASS_NEEDS_REASON",
      "Holding a make-up past the 14-day window needs a reason.",
      400,
    );
  }
  const appointmentId = hosted.appointment.id;
  return withAppointmentLock(appointmentId, () =>
    prisma.$transaction(async (tx) => {
      const now = new Date();
      const source = await tx.appointmentOccurrence.findFirst({
        where: { id: sourceOccurrenceId, appointmentId },
        select: {
          ordinal: true,
          startsAt: true,
          endsAt: true,
          completionStatus: true,
          hostCancelledAt: true,
          voidedAt: true,
          seatsSettledAt: true,
          consultantProfileId: true,
        },
      });
      // #1569 — a voided source is in the past; only the make-up must be ahead.
      const lostAt = source ? missedAt(source) : null;
      const deadline = lostAt
        ? lostAt.getTime() + MAKEUP_WINDOW_DAYS * DAY_MS
        : 0;
      if (
        !source ||
        !isMiss(source) ||
        source.seatsSettledAt ||
        (!bypass && startsAt.getTime() > deadline) ||
        startsAt <= now
      ) {
        throw new BookingRuleError(
          "MAKEUP_WINDOW_LAPSED",
          `A make-up must be held within ${MAKEUP_WINDOW_DAYS} days of the missed session, and in the future.`,
        );
      }
      const endsAt = new Date(
        startsAt.getTime() +
          (source.endsAt.getTime() - source.startsAt.getTime()),
      );
      let makeUp;
      try {
        makeUp = await tx.appointmentOccurrence.create({
          data: {
            appointmentId,
            ordinal: source.ordinal,
            startsAt,
            endsAt,
            isTentative: false,
            consultantProfileId: source.consultantProfileId,
            // A make-up is a session moved on the buyer (decision 6).
            movedAt: now,
          },
          select: { id: true },
        });
      } catch (err) {
        // The live-ordinal partial unique: one live row per position.
        if (
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === "P2002"
        ) {
          throw new BookingRuleError(
            "MAKEUP_EXISTS",
            "A make-up for this session is already scheduled.",
          );
        }
        throw err;
      }
      // #1569 — the hold anchors on the last live session's end.
      await recomputeEarningsHold(tx, appointmentId);
      const seats = await tx.appointmentParticipant.findMany({
        where: { appointmentId, ...SEATED },
        select: { userId: true },
      });
      if (seats.length > 0) {
        await stageBell(tx, {
          workflowId: NOVU_WORKFLOWS.CLASS_MAKEUP_SCHEDULED,
          recipients: seats.map((s) => s.userId),
          payload: {
            planTitle: hosted.cls.classPlan.title,
            dateTime: when(startsAt),
            // #1527 — every seat holder here is a consultee.
            dashboardUrl: goHref("client", "appointments"),
          },
          dedupeKey: `makeup:${sourceOccurrenceId}`,
        });
      }
      return { occurrenceId: makeUp.id, startsAt, endsAt };
    }),
  );
}

/**
 * E-3b — a seat that cannot make the make-up takes that session back now,
 * one unit under the SAME key the day-14 sweep uses, so it can never be
 * refunded twice. Allowed while the make-up has not started.
 */
export async function skipClassMakeUp(args: {
  appointmentId: string;
  sourceOccurrenceId: string;
  userId: string;
  /** #1771 — an ops door refunds on the learner's seat but names the operator. */
  initiatedByUserId?: string;
}) {
  const source = await prisma.appointmentOccurrence.findFirst({
    where: {
      id: args.sourceOccurrenceId,
      appointmentId: args.appointmentId,
      ...MISS_WHERE,
      seatsSettledAt: null,
    },
    select: { ordinal: true, startsAt: true },
  });
  const makeUp = source
    ? await prisma.appointmentOccurrence.findFirst({
        where: {
          appointmentId: args.appointmentId,
          ordinal: source.ordinal,
          deletedAt: null,
          completionStatus: OccurrenceCompletionStatus.SCHEDULED,
          startsAt: { gt: new Date() },
        },
        select: { id: true },
      })
    : null;
  const seat = await prisma.appointmentParticipant.findFirst({
    where: {
      appointmentId: args.appointmentId,
      userId: args.userId,
      ...SEATED,
    },
    select: { createdAt: true, paymentId: true, sessionsPurchased: true },
  });
  // The live seat's own order: an earlier purchase may be a left-and-refunded seat.
  const payment = seat
    ? await prisma.payment.findFirst({
        where: {
          ...(seat.paymentId
            ? { id: seat.paymentId }
            : { appointmentId: args.appointmentId, userId: args.userId }),
          paymentStatus: "SUCCEEDED",
          deletedAt: null,
        },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          amount: true,
          createdAt: true,
          paymentIntent: true,
        },
      })
    : null;
  if (!source || !makeUp || !seat || !payment) {
    throw new BookingRuleError(
      "MAKEUP_NOT_SKIPPABLE",
      "This session has no upcoming make-up to skip, or you do not hold it.",
    );
  }
  const joinedAt = new Date(
    Math.max(payment.createdAt.getTime(), seat.createdAt.getTime()),
  );
  if (source.startsAt <= joinedAt) {
    throw new BookingRuleError(
      "MAKEUP_NOT_SKIPPABLE",
      "This session was before your seat was bought.",
    );
  }
  const ledger = await seatLedger(
    prisma,
    {
      appointmentId: args.appointmentId,
      createdAt: joinedAt,
      sessionsPurchased: seat.sessionsPurchased,
    },
    payment.amount,
  );
  if (ledger.unitPaise <= BigInt(0)) {
    // A credit-funded seat: the credits rail restores whole or not at all.
    await recordSystemError({
      category: "PAYMENT",
      summary: `Credit seat skipped class make-up ${args.sourceOccurrenceId} — per-session credit needs a human`,
      err: new Error("CREDIT_SEAT_PARTIAL_RESTORE"),
      context: { ...args, paymentId: payment.id },
    }).catch(() => {});
    return { refundId: null, amountRefundedPaise: 0, rail: "CREDITS" as const };
  }
  const dedupeKey = occurrenceRefundKey(args.sourceOccurrenceId, payment.id);
  try {
    const refunded = await refundBookingPayment({
      paymentId: payment.id,
      amountPaise: Number(ledger.unitPaise),
      reason: `class session ${args.sourceOccurrenceId} skipped — make-up not attended`,
      initiatedByUserId: args.initiatedByUserId ?? args.userId,
      dedupeKey,
      keepSeat: true,
    });
    return { ...refunded, status: "SUCCEEDED" as const };
  } catch (err) {
    return skipRefundInFlight(err, dedupeKey, payment.paymentIntent);
  }
}

/**
 * #1780 E-3b (QA #1821 case 10) — a throw after the keyed Refund row was
 * written (a gateway transport fault, a failed settle) leaves the money in
 * flight for the reconcile cron; the retry answered that row, so the first
 * call answers it too, and a modelled refusal is a 409 rather than a 500.
 */
async function skipRefundInFlight(
  err: unknown,
  dedupeKey: string,
  paymentIntent: string,
) {
  const inFlight = await findDedupedRefund(dedupeKey).catch(() => null);
  if (inFlight) {
    return {
      refundId: inFlight.refundId,
      amountRefundedPaise: inFlight.amountRefundedPaise,
      rail: fundingRailForIntent(paymentIntent),
      status: inFlight.status,
    };
  }
  if (err instanceof RefundValidationError) {
    throw new BookingRuleError(
      "MAKEUP_NOT_SKIPPABLE",
      "This session can no longer be refunded.",
    );
  }
  throw err;
}
