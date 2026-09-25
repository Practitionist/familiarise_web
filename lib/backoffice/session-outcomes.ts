/**
 * #1569 A-10 — the ops side of session outcomes: overturn one session's
 * verdict (`session.set-outcome`), and list the sessions only a human can
 * decide. A void's make-up or refund is money, so an overturn that would
 * un-void a session is refused once either has happened.
 */

import {
  OccurrenceCompletionStatus,
  type OccurrenceOutcome,
} from "@prisma/client";

import prisma, { type Tx } from "@/lib/prisma";
import { onClassSessionVoided } from "@/lib/booking/class-sessions";
import {
  COMPLETION_FOR_OUTCOME,
  HOST_ATTRIBUTED_OUTCOMES,
} from "@/lib/booking/session-outcome";
import { AWAITING_HUMAN } from "@/lib/booking/misses";
import { transitionOccurrenceCompletion } from "@/lib/booking/transitions";
import { withAppointmentLock } from "@/utils/appointmentlock";
import { OpsRefusal } from "./ops-refusal-error";

const DECIDED: OccurrenceCompletionStatus[] = [
  "COMPLETED",
  "UNVERIFIED",
  "VOIDED",
];

/** A keyed refund for this occurrence that moved, or is moving, money. */
async function voidRefundExists(tx: Tx, occurrenceId: string) {
  const row = await tx.refund.findFirst({
    where: {
      status: { notIn: ["FAILED", "CANCELLED"] },
      OR: [
        { dedupeKey: { startsWith: `occ:${occurrenceId}:` } },
        { dedupeKey: { startsWith: `void-unused:${occurrenceId}:` } },
      ],
    },
    select: { id: true },
  });
  return row !== null;
}

/** Overturn one past session's outcome; the status follows the outcome. */
export async function setSessionOutcome(
  tx: Tx,
  args: {
    occurrenceId: string;
    outcome: OccurrenceOutcome;
    actorUserId: string;
    now?: Date;
  },
) {
  const now = args.now ?? new Date();
  const occ = await tx.appointmentOccurrence.findUnique({
    where: { id: args.occurrenceId },
    select: {
      id: true,
      appointmentId: true,
      ordinal: true,
      startsAt: true,
      endsAt: true,
      completionStatus: true,
      outcome: true,
      seatsSettledAt: true,
      deletedAt: true,
      isTentative: true,
      appointment: { select: { classId: true } },
    },
  });
  if (
    !occ ||
    occ.deletedAt ||
    occ.isTentative ||
    occ.endsAt > now ||
    !DECIDED.includes(occ.completionStatus)
  ) {
    throw new OpsRefusal(
      "SESSION_NOT_DECIDED",
      "Only a past session the outcome sweep has decided can be overturned.",
    );
  }
  const to = COMPLETION_FOR_OUTCOME[args.outcome];
  if (occ.completionStatus === "VOIDED" && to !== "VOIDED") {
    // An owed make-up or refund has already been honoured, or a make-up holds
    // the ordinal the un-voided row would take back.
    const makeUp = await tx.appointmentOccurrence.findFirst({
      where: {
        appointmentId: occ.appointmentId,
        ordinal: occ.ordinal,
        id: { not: occ.id },
        deletedAt: null,
        completionStatus: { in: ["SCHEDULED", "COMPLETED", "UNVERIFIED"] },
      },
      select: { id: true },
    });
    if (occ.seatsSettledAt || makeUp || (await voidRefundExists(tx, occ.id))) {
      throw new OpsRefusal(
        "OUTCOME_SETTLED",
        "This void was already made up or refunded, so it can no longer be overturned.",
      );
    }
  }
  const data = {
    outcome: args.outcome,
    outcomeAt: now,
    voidedAt: to === "VOIDED" ? now : null,
  };
  const history = {
    reason: `ops:session.set-outcome:${args.outcome}`,
    actorUserId: args.actorUserId,
  };
  if (to === occ.completionStatus) {
    // A relabel inside one status is not a status write; CAS on the status read.
    const { count } = await tx.appointmentOccurrence.updateMany({
      where: { id: occ.id, completionStatus: occ.completionStatus },
      data: { outcome: args.outcome, outcomeAt: now },
    });
    if (count === 0) {
      throw new OpsRefusal("SESSION_MOVED", "This session changed; reload.");
    }
  } else {
    await transitionOccurrenceCompletion(tx, {
      where: {
        id: occ.id,
        deletedAt: null,
        isTentative: false,
        // A settle stamp landing after the read must win over an un-void.
        ...(occ.completionStatus === "VOIDED" && { seatsSettledAt: null }),
      },
      to,
      fromIn: [occ.completionStatus],
      data,
      ...history,
    });
    if (to === "VOIDED" && occ.appointment.classId) {
      await onClassSessionVoided(tx, {
        appointmentId: occ.appointmentId,
        occurrenceId: occ.id,
        startsAt: occ.startsAt,
        voidedAt: now,
        hostAttributed: HOST_ATTRIBUTED_OUTCOMES.includes(args.outcome),
      });
    }
  }
  return {
    before: { completionStatus: occ.completionStatus, outcome: occ.outcome },
    after: { completionStatus: to, outcome: args.outcome },
  };
}

/**
 * The door's entry: under the appointment lock the settle sweep holds, so an
 * un-void and that session's refund cannot both win.
 */
export async function overturnSessionOutcome(args: {
  occurrenceId: string;
  outcome: OccurrenceOutcome;
  actorUserId: string;
}) {
  const occ = await prisma.appointmentOccurrence.findUnique({
    where: { id: args.occurrenceId },
    select: { appointmentId: true },
  });
  if (!occ) {
    throw new OpsRefusal("SESSION_NOT_FOUND", "No such session.", 404);
  }
  return withAppointmentLock(occ.appointmentId, () =>
    prisma.$transaction((tx) => setSessionOutcome(tx, args)),
  );
}

/**
 * Sessions only a human can decide: an INCONCLUSIVE verdict, a consultation
 * host no-show the detector declined, a call the maintenance drain cut, and a
 * paid trial that was voided (D4). None of them moves money on its own.
 */
export async function readSessionsNeedingHuman(limit = 100) {
  return prisma.appointmentOccurrence.findMany({
    where: {
      deletedAt: null,
      isTentative: false,
      OR: [
        AWAITING_HUMAN,
        {
          completionStatus: "VOIDED",
          seatsSettledAt: null,
          appointment: { trial: { paymentId: { not: null } } },
        },
      ],
    },
    orderBy: { endsAt: "desc" },
    take: limit,
    select: {
      id: true,
      appointmentId: true,
      startsAt: true,
      endsAt: true,
      completionStatus: true,
      outcome: true,
      deliveredMinutes: true,
      lostMinutes: true,
      meeting: { select: { endedReason: true } },
    },
  });
}
