/**
 * The ops side of session outcomes: overturn one session's verdict
 * (`session.set-outcome`), confirm a negative one (`session.confirm-outcome`),
 * read Stream's record of a session again
 * (`session.reread-attendance`), and page through the sessions only a human
 * can decide. A void's make-up or refund is money, so an overturn that would
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
  classifySessionOutcome,
  COMPLETION_FOR_OUTCOME,
  HOST_ATTRIBUTED_OUTCOMES,
} from "@/lib/booking/session-outcome";
import {
  OUTCOME_REPORT_FIELDS,
  readOutageWindows,
  readRoomEnd,
  REPORT_PARTIES_SELECT,
  reportParties,
} from "@/lib/booking/session-outcome-sweep";
import {
  CLASSIFIED_REPORT_REASONS,
  countedEffect,
  reasonSide,
} from "@/lib/booking/outcome-reports";
import { SupportFlowReasonEnum } from "@/schemas/enums";
import {
  SESSION_HOSTS_SELECT,
  sessionHostUserIds,
} from "@/lib/booking/session-hosts";
import {
  SETTLE_MEETING_SELECT,
  settleOccurrenceAttendance,
  type AttendanceSettlement,
} from "@/lib/meetings/settle-attendance";
import { INCIDENT_REFUND_KEY_PREFIX } from "@/lib/booking/incident-keys";
import {
  isAgedNeedsHuman,
  isNegativeMoneyOutcome,
  needsHumanWhere,
  reportWindowClosesAt,
} from "@/lib/booking/misses";
import {
  OCCURRENCE_COMPLETION_ALLOWED_FROM,
  transitionOccurrenceCompletion,
} from "@/lib/booking/transitions";
import {
  APPOINTMENT_HEADLINE_SELECT,
  appointmentHeadline,
  headlineUserIds,
  type HeadlineUser,
} from "@/lib/data/appointment-headline";
import { meetingEndReasonSchema } from "@/lib/meetings/end-reasons";
import { withAppointmentLock } from "@/utils/appointmentlock";
import {
  NEEDS_HUMAN_DEFAULT_SORT,
  NEEDS_HUMAN_PAGE_SIZE,
  type NeedsHumanPage,
  type NeedsHumanReport,
  type NeedsHumanSort,
} from "./needs-human-queue";
import { OpsRefusal } from "./ops-refusal-error";

const DECIDED = new Set<OccurrenceCompletionStatus>([
  "COMPLETED",
  "UNVERIFIED",
  "VOIDED",
]);

/** A keyed refund for this occurrence that moved, or is moving, money. */
export async function voidRefundExists(
  tx: Pick<Tx, "refund">,
  occurrenceId: string,
) {
  const row = await tx.refund.findFirst({
    where: {
      status: { notIn: ["FAILED", "CANCELLED"] },
      OR: [
        { dedupeKey: { startsWith: `occ:${occurrenceId}:` } },
        {
          dedupeKey: {
            startsWith: INCIDENT_REFUND_KEY_PREFIX,
            contains: `:${occurrenceId}:`,
          },
        },
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
  appointment: {
    select: { classId: true, subscription: { select: { status: true } } },
  },
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

/** A negative verdict ops write is confirmed as written; any other carries no stamp. */
const confirmedByOps = (outcome: OccurrenceOutcome, now: Date) =>
  isNegativeMoneyOutcome(outcome) ? now : null;

/** A relabel inside one status is not a status write; CAS on the status read. */
async function relabel(
  tx: Tx,
  occ: OverturnRow,
  args: OverturnArgs,
  now: Date,
) {
  const { count } = await tx.appointmentOccurrence.updateMany({
    where: { id: occ.id, completionStatus: occ.completionStatus },
    data: {
      outcome: args.outcome,
      outcomeAt: now,
      outcomeConfirmedAt: confirmedByOps(args.outcome, now),
    },
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
      relabelled: true,
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
      outcomeConfirmedAt: confirmedByOps(args.outcome, now),
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
  // #1834 — the door's fromIn is the row's own status, so the map is asked here.
  if (
    to !== occ.completionStatus &&
    !OCCURRENCE_COMPLETION_ALLOWED_FROM[to].includes(occ.completionStatus)
  ) {
    throw new OpsRefusal(
      "TRANSITION_NOT_ALLOWED",
      `A ${occ.completionStatus.toLowerCase()} session cannot be given this outcome.`,
    );
  }
  if (occ.completionStatus === "VOIDED" && to !== "VOIDED") {
    await assertUnvoidable(tx, occ);
  }
  // A subscription's voids are settled with its plan; once the plan has ended
  // or been cancelled nothing would ever refund a new one.
  const plan = occ.appointment.subscription;
  if (
    to === "VOIDED" &&
    occ.completionStatus !== "VOIDED" &&
    plan &&
    plan.status !== "APPROVED"
  ) {
    throw new OpsRefusal(
      "PLAN_SETTLED",
      "This plan has already ended or been cancelled, so its sessions can no longer be voided.",
    );
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
 * Confirms a negative verdict as it stands, under the appointment lock the
 * overturn takes. Sets only the stamp, by CAS from null, so `outcomeAt` keeps its time.
 */
/** Runs in the door's transaction, so the stamp commits only with its audit row; the CAS needs no lock. */
export async function confirmSessionOutcome(
  tx: Tx,
  args: {
    occurrenceId: string;
    outcome: OccurrenceOutcome;
    now?: Date;
  },
) {
  const now = args.now ?? new Date();
  const { outcome } = args;
  if (!isNegativeMoneyOutcome(outcome)) {
    throw new OpsRefusal(
      "OUTCOME_NOT_CONFIRMABLE",
      "Only a host-absent, cut-short or learner-absent verdict needs a confirmation.",
    );
  }
  const { count } = await tx.appointmentOccurrence.updateMany({
    where: {
      id: args.occurrenceId,
      outcome,
      outcomeConfirmedAt: null,
      deletedAt: null,
      // A parked UNVERIFIED verdict is decided through set-outcome, not confirmed as it stands.
      completionStatus: { in: ["COMPLETED", "VOIDED"] },
    },
    data: { outcomeConfirmedAt: now },
  });
  if (count === 0) {
    const exists = await tx.appointmentOccurrence.findUnique({
      where: { id: args.occurrenceId },
      select: { id: true },
    });
    if (!exists) {
      throw new OpsRefusal("SESSION_NOT_FOUND", "No such session.", 404);
    }
    throw new OpsRefusal("SESSION_MOVED", "This session changed; reload.");
  }
  return {
    before: { outcome, outcomeConfirmedAt: null },
    after: { outcome, outcomeConfirmedAt: now.toISOString() },
  };
}

/** Ops may ask Stream again until this many days after the session; Stream drops the detail after 90. */
export const ATTENDANCE_REREAD_DAYS = 80;

/** The re-read's whole Stream read must answer within this, leaving the request its ops audit write inside the ~26 s edge limit. */
export const REREAD_SETTLE_BUDGET_MS = 12_000;

const rereadDeadline = (endsAt: Date) =>
  new Date(endsAt.getTime() + ATTENDANCE_REREAD_DAYS * 86_400_000);

export type AttendanceReread = {
  result: AttendanceSettlement["kind"];
  /** What the classifier makes of the stored record; ops apply it through `session.set-outcome`. */
  verdict: {
    outcome: OccurrenceOutcome;
    deliveredMinutes: number | null;
    lostMinutes: number | null;
  } | null;
};

/**
 * Runs the same settle step the sweep runs for one session and answers the
 * verdict its stored record gives. It writes only the snapshot: the outcome,
 * and any money it moves, stays with the set-outcome door.
 */
export async function rereadSessionAttendance(args: {
  occurrenceId: string;
  now?: Date;
  /** Epoch ms by which every Stream read must answer; defaults to the request's budget. */
  deadlineAt?: number;
}): Promise<AttendanceReread> {
  const now = args.now ?? new Date();
  const deadlineAt = args.deadlineAt ?? Date.now() + REREAD_SETTLE_BUDGET_MS;
  const occ = await prisma.appointmentOccurrence.findUnique({
    where: { id: args.occurrenceId },
    select: {
      id: true,
      startsAt: true,
      endsAt: true,
      meeting: { select: SETTLE_MEETING_SELECT },
      appointment: { select: SESSION_HOSTS_SELECT },
    },
  });
  if (!occ) throw new OpsRefusal("SESSION_NOT_FOUND", "No such session.", 404);
  if (!occ.meeting) {
    throw new OpsRefusal(
      "SESSION_HAD_NO_CALL",
      "This session had no video call, so Stream holds no record of it.",
    );
  }
  if (now > rereadDeadline(occ.endsAt)) {
    throw new OpsRefusal(
      "STREAM_RECORD_GONE",
      `Stream keeps a call's participant record for 90 days; a re-read is offered for ${ATTENDANCE_REREAD_DAYS}.`,
    );
  }
  const settled = await settleOccurrenceAttendance(
    { occurrenceId: occ.id, endsAt: occ.endsAt, meeting: occ.meeting },
    { now, deadlineAt },
  );
  if (settled.kind !== "settled")
    return { result: settled.kind, verdict: null };
  const room = await readRoomEnd(occ.meeting.id);
  const verdict = classifySessionOutcome({
    startsAt: occ.startsAt,
    endsAt: occ.endsAt,
    hostUserIds: sessionHostUserIds(occ.appointment),
    intervals: settled.intervals,
    meeting: room && { endedAt: room.endedAt, endedReason: room.endedReason },
    maintenanceWindows: await readOutageWindows(prisma, occ.startsAt),
  });
  return {
    result: "settled",
    verdict: {
      outcome: verdict.outcome,
      deliveredMinutes: verdict.deliveredMinutes,
      lostMinutes: verdict.lostMinutes,
    },
  };
}

const NEEDS_HUMAN_ROW_SELECT = {
  id: true,
  appointmentId: true,
  startsAt: true,
  endsAt: true,
  outcomeAt: true,
  outcomeConfirmedAt: true,
  completionStatus: true,
  outcome: true,
  deliveredMinutes: true,
  lostMinutes: true,
  meeting: { select: { endedReason: true } },
  appointment: { select: APPOINTMENT_HEADLINE_SELECT },
} satisfies Prisma.AppointmentOccurrenceSelect;

/** The ORDER BY for a whitelisted sort; nullable columns put their nulls last, and id keeps pages stable. */
function needsHumanOrderBy(
  sort: NeedsHumanSort,
): Prisma.AppointmentOccurrenceOrderByWithRelationInput[] {
  const { dir } = sort;
  let first: Prisma.AppointmentOccurrenceOrderByWithRelationInput;
  if (sort.key === "outcomeAt") {
    first = { outcomeAt: { sort: dir, nulls: "last" } };
  } else if (sort.key === "lostMinutes") {
    first = { lostMinutes: { sort: dir, nulls: "last" } };
  } else if (sort.key === "startsAt") {
    first = { startsAt: dir };
  } else {
    first = { endsAt: dir };
  }
  return [first, { id: "asc" }];
}

const personOf = (u: HeadlineUser | null) =>
  u ? { id: u.id, name: u.name, email: u.email } : null;

/** The counted disputes and agreements on each negative verdict of the page; no read when there is none. */
async function readPageReports(
  rows: {
    id: string;
    endsAt: Date;
    outcome: OccurrenceOutcome | null;
    outcomeAt: Date | null;
  }[],
): Promise<Map<string, NeedsHumanReport[]>> {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const ids = rows
    .filter((r) => isNegativeMoneyOutcome(r.outcome) && r.outcomeAt)
    .map((r) => r.id);
  const out = new Map<string, NeedsHumanReport[]>();
  if (ids.length === 0) return out;
  // The case's own timestamps are top-level, so a join reads them as stored.
  const cases = await prisma.supportCase.findMany({
    relationLoadStrategy: "join",
    where: {
      appointmentOccurrenceId: { in: ids },
      deletedAt: null,
      flowReason: { in: CLASSIFIED_REPORT_REASONS },
    },
    orderBy: [{ flowReasonAt: "asc" }, { id: "asc" }],
    select: {
      ...OUTCOME_REPORT_FIELDS,
      appointmentOccurrenceId: true,
      occurrence: {
        select: { appointment: { select: REPORT_PARTIES_SELECT } },
      },
    },
  });
  for (const c of cases) {
    const row = c.appointmentOccurrenceId
      ? byId.get(c.appointmentOccurrenceId)
      : undefined;
    if (
      !row?.outcomeAt ||
      !c.occurrence ||
      !isNegativeMoneyOutcome(row.outcome)
    )
      continue;
    const effect = countedEffect(c, {
      outcome: row.outcome,
      endsAt: row.endsAt,
      windowClosesAt: reportWindowClosesAt(row.outcomeAt),
      ...reportParties(c.occurrence.appointment),
    });
    const side = reasonSide(c.flowReason);
    const reason = SupportFlowReasonEnum.safeParse(c.flowReason);
    if (!effect || !side || !reason.success) continue;
    out.set(row.id, [
      ...(out.get(row.id) ?? []),
      { caseId: c.id, side, reason: reason.data },
    ]);
  }
  return out;
}

/**
 * Sessions only a human can decide: an INCONCLUSIVE verdict, a consultation
 * host no-show the detector declined, a call the maintenance drain cut, a
 * paid trial that was voided (D4), a negative verdict whose window closed
 * unconfirmed, and one a participant reported on. None of them moves money on
 * its own. One page in three statements: the list, its count and one batched
 * user read, plus one report read when the page holds a negative verdict.
 */
export async function readSessionsNeedingHuman({
  page = 1,
  sort = NEEDS_HUMAN_DEFAULT_SORT,
  now = new Date(),
}: {
  page?: number;
  sort?: NeedsHumanSort;
  now?: Date;
} = {}): Promise<NeedsHumanPage> {
  const where = needsHumanWhere(now);
  const [rows, total] = await Promise.all([
    prisma.appointmentOccurrence.findMany({
      relationLoadStrategy: "join",
      where,
      orderBy: needsHumanOrderBy(sort),
      skip: (page - 1) * NEEDS_HUMAN_PAGE_SIZE,
      take: NEEDS_HUMAN_PAGE_SIZE,
      select: NEEDS_HUMAN_ROW_SELECT,
    }),
    prisma.appointmentOccurrence.count({ where }),
  ]);
  const userIds = headlineUserIds(rows.map((r) => r.appointment));
  const [users, reports] = await Promise.all([
    userIds.length > 0
      ? prisma.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, name: true, email: true, image: true },
        })
      : [],
    readPageReports(rows),
  ]);
  const usersById = new Map(users.map((u) => [u.id, u]));
  const items = rows.map((row) => {
    const headline = appointmentHeadline(row.appointment, usersById);
    return {
      id: row.id,
      appointmentId: row.appointmentId,
      startsAt: row.startsAt.toISOString(),
      endsAt: row.endsAt.toISOString(),
      outcomeAt: row.outcomeAt?.toISOString() ?? null,
      completionStatus: row.completionStatus,
      outcome: row.outcome,
      lostMinutes: row.lostMinutes,
      // A sidecar CHECK keeps the column to the known reasons.
      endedReason:
        meetingEndReasonSchema.safeParse(row.meeting?.endedReason).data ?? null,
      aged: isAgedNeedsHuman(row, now),
      // Stays offered once settled: a settled re-read only recomputes the verdict from the stored rows.
      canRereadAttendance: !!row.meeting && now <= rereadDeadline(row.endsAt),
      // An applied negative verdict nobody confirmed; a parked UNVERIFIED one is decided through set-outcome.
      canConfirm:
        isNegativeMoneyOutcome(row.outcome) &&
        row.outcomeConfirmedAt === null &&
        row.completionStatus !== "UNVERIFIED",
      reports: reports.get(row.id) ?? [],
      booking: {
        type: row.appointment.appointmentType,
        title: headline.title,
        expert: personOf(headline.expert),
        learner: personOf(headline.learner),
        attendeeLabel: headline.attendeeLabel,
        removed: row.appointment.deletedAt !== null,
      },
    };
  });
  return { items, total, page, pageSize: NEEDS_HUMAN_PAGE_SIZE };
}
