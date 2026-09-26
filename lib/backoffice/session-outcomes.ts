/**
 * #1569 A-10 — the ops side of session outcomes: overturn one session's
 * verdict (`session.set-outcome`), and list the sessions only a human can
 * decide. A void's make-up or refund is money, so an overturn that would
 * un-void a session is refused once either has happened.
 */

import {
  OccurrenceCompletionStatus,
  type OccurrenceOutcome,
  type Prisma,
} from "@prisma/client";

import prisma, { type Tx } from "@/lib/prisma";
import { onClassSessionVoided } from "@/lib/booking/class-sessions";
import {
  COMPLETION_FOR_OUTCOME,
  HOST_ATTRIBUTED_OUTCOMES,
} from "@/lib/booking/session-outcome";
import { NEEDS_HUMAN } from "@/lib/booking/misses";
import { transitionOccurrenceCompletion } from "@/lib/booking/transitions";
import { withAppointmentLock } from "@/utils/appointmentlock";
import { OpsRefusal } from "./ops-refusal-error";

const DECIDED = new Set<OccurrenceCompletionStatus>([
  "COMPLETED",
  "UNVERIFIED",
  "VOIDED",
]);

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

const OVERTURN_SELECT = {
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
} satisfies Prisma.AppointmentOccurrenceSelect;

type OverturnRow = Prisma.AppointmentOccurrenceGetPayload<{
  select: typeof OVERTURN_SELECT;
}>;

type OverturnArgs = {
  occurrenceId: string;
  outcome: OccurrenceOutcome;
  actorUserId: string;
  now?: Date;
};

/** Only a live, past session the sweep has decided may be overturned. */
function assertDecided(
  occ: OverturnRow | null,
  now: Date,
): asserts occ is OverturnRow {
  if (
    !occ ||
    occ.deletedAt ||
    occ.isTentative ||
    occ.endsAt > now ||
    !DECIDED.has(occ.completionStatus)
  ) {
    throw new OpsRefusal(
      "SESSION_NOT_DECIDED",
      "Only a past session the outcome sweep has decided can be overturned.",
    );
  }
}

/**
 * An un-void is refused once its make-up or refund was honoured, or a make-up
 * holds the ordinal the un-voided row would take back.
 */
async function assertUnvoidable(tx: Tx, occ: OverturnRow) {
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

/** A relabel inside one status is not a status write; CAS on the status read. */
async function relabel(
  tx: Tx,
  occ: OverturnRow,
  args: OverturnArgs,
  now: Date,
) {
  const { count } = await tx.appointmentOccurrence.updateMany({
    where: { id: occ.id, completionStatus: occ.completionStatus },
    data: { outcome: args.outcome, outcomeAt: now },
  });
  if (count === 0) {
    throw new OpsRefusal("SESSION_MOVED", "This session changed; reload.");
  }
  // A relabel moves no money, but a void newly blamed on the host feeds D6's flag.
  const nowHostAttributed =
    HOST_ATTRIBUTED_OUTCOMES.includes(args.outcome) &&
    !(occ.outcome && HOST_ATTRIBUTED_OUTCOMES.includes(occ.outcome));
  if (
    occ.completionStatus === "VOIDED" &&
    nowHostAttributed &&
    occ.appointment.classId
  ) {
    await onClassSessionVoided(tx, {
      appointmentId: occ.appointmentId,
      occurrenceId: occ.id,
      startsAt: occ.startsAt,
      voidedAt: now,
      hostAttributed: true,
    });
  }
}

/** A status move through the CAS helper, plus the class void side effects. */
async function moveStatus(
  tx: Tx,
  occ: OverturnRow,
  args: OverturnArgs,
  to: OccurrenceCompletionStatus,
  now: Date,
) {
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
    data: {
      outcome: args.outcome,
      outcomeAt: now,
      voidedAt: to === "VOIDED" ? now : null,
    },
    reason: `ops:session.set-outcome:${args.outcome}`,
    actorUserId: args.actorUserId,
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

/** Overturn one past session's outcome; the status follows the outcome. */
export async function setSessionOutcome(tx: Tx, args: OverturnArgs) {
  const now = args.now ?? new Date();
  const occ = await tx.appointmentOccurrence.findUnique({
    where: { id: args.occurrenceId },
    select: OVERTURN_SELECT,
  });
  assertDecided(occ, now);
  const to = COMPLETION_FOR_OUTCOME[args.outcome];
  if (occ.completionStatus === "VOIDED" && to !== "VOIDED") {
    await assertUnvoidable(tx, occ);
  }
  if (to === occ.completionStatus) await relabel(tx, occ, args, now);
  else await moveStatus(tx, occ, args, to, now);
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
    where: NEEDS_HUMAN,
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
