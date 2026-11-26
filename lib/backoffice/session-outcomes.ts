/**
 * The ops side of session outcomes: overturn one session's verdict
 * (`session.set-outcome`), confirm a negative one (`session.confirm-outcome`),
 * read Stream's record of a session again
 * (`session.reread-attendance`), and page through the sessions only a human
 * can decide. A void's make-up or refund is money, so an overturn that would
 * un-void a session is refused once either has happened. Expert absent on a
 * consultation cancels and refunds the whole booking where every live session
 * is expert absent, and otherwise voids the one session; either way with a strike.
 */

import {
  OccurrenceCompletionStatus,
  type OccurrenceOutcome,
  type Prisma,
} from "@prisma/client";

import prisma, { type Tx } from "@/lib/prisma";
import {
  cancelUnstartedMakeUp,
  onClassSessionVoided,
  onClassVoidConfirmed,
} from "@/lib/booking/class-sessions";
import { isCompletedOccurrence } from "@/lib/booking/entitlement";
import { flushNotificationsAfter } from "@/lib/novu/stage-then-attempt";
import {
  classifySessionOutcome,
  COMPLETION_FOR_OUTCOME,
  HOST_ATTRIBUTED_OUTCOMES,
} from "@/lib/booking/session-outcome";
import {
  flushClassVoidNotices,
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
  makeUpWindowStart,
  needsHumanWhere,
  PROPOSED_CONSULTANT_NO_SHOW,
  reportWindowClosesAt,
} from "@/lib/booking/misses";
import { unstampUndeliveredTranches } from "@/lib/booking/subscription-cycle";
import {
  claimNoShowTx,
  NoShowDuringOutageError,
  readNoShowClaim,
  oweSessionNoShowRefundTx,
  readOperatorNoShowClaim,
  readSessionNoShow,
  settleClaimedNoShow,
  settleSessionNoShowRefund,
  type NoShowClaim,
  type NoShowClaimBar,
  type NoShowSibling,
  type SessionNoShowRefund,
} from "@/lib/booking/consultant-no-show";
import { recordExpertStrike } from "@/lib/booking/expert-reliability";
import { readOverlappingOutages } from "@/lib/booking/outage-windows";
import { IllegalTransitionError } from "@/lib/enterprise/transitions";
import { createRunFailureReporter } from "@/lib/observability/run-failures";
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
  outcomeConfirmedAt: true,
  voidedAt: true,
  seatsSettledAt: true,
  deletedAt: true,
  isTentative: true,
  appointment: {
    select: {
      classId: true,
      organizationId: true,
      consultation: {
        select: {
          consultationPlan: { select: { consultantProfileId: true } },
        },
      },
      subscription: { select: { status: true } },
    },
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

type ClassVoidNotices = Awaited<ReturnType<typeof onClassSessionVoided>>;

/**
 * What a relabel writes besides the outcome. A void keeps the start of its 14-day make-up window:
 * only one whose verdict was still waiting for a confirmation starts it now. The start lives in
 * `outcomeConfirmedAt` for a negative outcome and in `voidedAt` for any other (`makeUpWindowStart`).
 */
function relabelStamps(
  occ: OverturnRow,
  outcome: OccurrenceOutcome,
  now: Date,
): { outcomeConfirmedAt: Date | null; voidedAt?: Date } {
  if (occ.completionStatus !== "VOIDED") {
    return { outcomeConfirmedAt: confirmedByOps(outcome, now) };
  }
  const windowStart = makeUpWindowStart(occ) ?? now;
  return isNegativeMoneyOutcome(outcome)
    ? { outcomeConfirmedAt: windowStart }
    : { outcomeConfirmedAt: null, voidedAt: windowStart };
}

/** A relabel inside one status is not a status write; CAS on the status, the outcome and the stamp read. */
async function relabel(
  tx: Tx,
  occ: OverturnRow,
  args: OverturnArgs,
  now: Date,
): Promise<ClassVoidNotices | null> {
  const { count } = await tx.appointmentOccurrence.updateMany({
    // A confirmation or another relabel since the read moves the session, so the miss is not counted twice.
    where: {
      id: occ.id,
      completionStatus: occ.completionStatus,
      outcome: occ.outcome,
      outcomeConfirmedAt: occ.outcomeConfirmedAt,
    },
    data: {
      outcome: args.outcome,
      outcomeAt: now,
      ...relabelStamps(occ, args.outcome, now),
    },
  });
  if (count === 0) {
    throw new OpsRefusal("SESSION_MOVED", "This session changed; reload.");
  }
  // A relabel moves no money, but a void newly counted against the host feeds D6's flag;
  // an unconfirmed host void was not counted yet, so ops writing one counts it as a new miss.
  const wasPending =
    isNegativeMoneyOutcome(occ.outcome) && occ.outcomeConfirmedAt === null;
  const wasCountedHost =
    !!occ.outcome &&
    HOST_ATTRIBUTED_OUTCOMES.includes(occ.outcome) &&
    !wasPending;
  const nowHostAttributed =
    HOST_ATTRIBUTED_OUTCOMES.includes(args.outcome) && !wasCountedHost;
  // An unconfirmed void ops relabel now counts as a series miss even when the outage is not the host's.
  if (
    occ.completionStatus === "VOIDED" &&
    (nowHostAttributed || wasPending) &&
    occ.appointment.classId
  ) {
    return onClassSessionVoided(tx, {
      appointmentId: occ.appointmentId,
      occurrenceId: occ.id,
      startsAt: occ.startsAt,
      voidedAt: now,
      hostAttributed: nowHostAttributed,
      relabelled: !wasPending,
    });
  }
  return null;
}

/** A status move through the CAS helper, plus the class void side effects. */
async function moveStatus(
  tx: Tx,
  occ: OverturnRow,
  args: OverturnArgs,
  to: OccurrenceCompletionStatus,
  now: Date,
): Promise<ClassVoidNotices | null> {
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
  // A plan's delivered session just left its cycle undelivered. Before the class branch's return, so no path skips it.
  if (
    to === "VOIDED" &&
    occ.appointment.subscription &&
    isCompletedOccurrence(occ)
  ) {
    await unstampUndeliveredTranches(tx, {
      appointmentId: occ.appointmentId,
      now,
    });
  }
  if (to === "VOIDED" && occ.appointment.classId) {
    return onClassSessionVoided(tx, {
      appointmentId: occ.appointmentId,
      occurrenceId: occ.id,
      startsAt: occ.startsAt,
      voidedAt: now,
      hostAttributed: HOST_ATTRIBUTED_OUTCOMES.includes(args.outcome),
    });
  }
  return null;
}

const words = (value: string) => value.toLowerCase().replaceAll("_", " ");

const describeSibling = (sibling: NoShowSibling) =>
  `the session starting ${sibling.startsAt.toISOString()} is ${
    sibling.outcome
      ? `recorded as ${words(sibling.outcome)}`
      : `${words(sibling.completionStatus)} with no outcome`
  }`;

/** A paid booking whose other sessions stand: a void's day-14 refund is the whole payment, so one session cannot be voided alone. */
const otherSessionsStand = (detail: string, occurrenceId?: string) =>
  new OpsRefusal(
    "NO_SHOW_OTHER_SESSIONS_STAND",
    `This paid booking has other sessions that stand (${detail}). A voided consultation session is refunded as the whole payment after 14 days, so expert absent cannot be applied to one session of it. Refund this session's share through a refund recommendation on the booking's support case instead.`,
    409,
    occurrenceId ? { occurrenceId } : undefined,
  );

/**
 * Where the whole-booking claim does not fit, the one session is voided with a strike instead.
 * Answers the refusal when that does not fit either, or null when the session-level void may run.
 */
function sessionVoidRefusal(bar: NoShowClaimBar, now: Date): OpsRefusal | null {
  switch (bar.reason) {
    case "UNPAID":
      return null;
    case "NOT_APPROVED":
      return bar.paid && bar.otherSessions > 0
        ? otherSessionsStand(
            `${bar.otherSessions} besides this one, on a booking that is ${words(bar.status)}`,
          )
        : null;
    case "SIBLING": {
      // A parked session, or one the outcome sweep has not judged yet, may still turn out expert absent.
      const undecided = (o: NoShowSibling) =>
        o.completionStatus === "UNVERIFIED" ||
        (o.completionStatus === "SCHEDULED" && o.endsAt <= now);
      const decided = bar.siblings.find((o) => !undecided(o));
      if (decided)
        return otherSessionsStand(describeSibling(decided), decided.id);
      const [sibling] = bar.siblings;
      return new OpsRefusal(
        "NO_SHOW_SIBLING_SESSION",
        `Another session of this booking has no decision yet: ${describeSibling(sibling)}. Decide that session first. If the expert was absent there too, set it expert absent and the whole booking is cancelled and refunded in full.`,
        409,
        { occurrenceId: sibling.id },
      );
    }
    default:
      return new OpsRefusal(
        "NO_SHOW_NOT_CLAIMABLE",
        "This session's booking has no expert, learner or live session on record, so neither a refund nor a strike can be attributed. Escalate it to engineering with the session id.",
      );
  }
}

/** No strike inside a declared incident or a maintenance window: that miss is not the expert's. */
async function refuseDuringOutage(tx: Tx, occ: OverturnRow): Promise<void> {
  const outages = await readOverlappingOutages(tx, [
    { startsAt: occ.startsAt, endsAt: occ.endsAt },
  ]);
  if (outages.length > 0) {
    throw new OpsRefusal(
      "NO_SHOW_DURING_OUTAGE",
      "A declared incident or maintenance window overlaps this session, so the miss is not the expert's. Set its outcome to a platform outage instead.",
    );
  }
}

/** The claim on the door's transaction, its misses as refusals; answers the refund drive to run after the commit. */
async function runNoShowClaim(
  tx: Tx,
  claim: NoShowClaim,
  actorUserId: string | null,
  now: Date,
): Promise<() => Promise<void>> {
  let held: Awaited<ReturnType<typeof claimNoShowTx>>["held"];
  try {
    ({ held } = await claimNoShowTx(tx, claim, { now, actorUserId }));
  } catch (error) {
    if (error instanceof IllegalTransitionError) {
      throw new OpsRefusal("SESSION_MOVED", "This session changed; reload.");
    }
    if (error instanceof NoShowDuringOutageError) {
      throw new OpsRefusal(
        "NO_SHOW_DURING_OUTAGE",
        "A declared incident or maintenance window overlaps this session, so the miss is not the expert's. Set its outcome to a platform outage instead.",
      );
    }
    throw error;
  }
  // The owed marker committed with the claim, so a lost drive is retried by the owed-refund sweep.
  return async () => {
    const failures = createRunFailureReporter("admin");
    try {
      await settleClaimedNoShow(claim, held, { errors: [], failures });
    } finally {
      failures.flush();
    }
  };
}

/** Parks the session as the unconfirmed expert-absent proposal the claim's compare-and-set cancels. */
async function parkAsNoShowProposal(
  tx: Tx,
  occ: OverturnRow,
  args: OverturnArgs,
  now: Date,
): Promise<void> {
  const proposal = {
    outcome: "HOST_ABSENT",
    outcomeAt: now,
    outcomeConfirmedAt: null,
  } as const;
  if (occ.completionStatus !== "UNVERIFIED") {
    await transitionOccurrenceCompletion(tx, {
      where: { id: occ.id, deletedAt: null, isTentative: false },
      to: "UNVERIFIED",
      fromIn: [occ.completionStatus],
      data: proposal,
      reason: `ops:session.set-outcome:${args.outcome}`,
      actorUserId: args.actorUserId,
    });
    return;
  }
  // Already the proposal: its verdict time stands.
  if (occ.outcome === "HOST_ABSENT" && occ.outcomeConfirmedAt === null) return;
  const { count } = await tx.appointmentOccurrence.updateMany({
    where: {
      id: occ.id,
      deletedAt: null,
      completionStatus: "UNVERIFIED",
      outcome: occ.outcome,
      outcomeConfirmedAt: occ.outcomeConfirmedAt,
    },
    data: proposal,
  });
  if (count === 0) {
    throw new OpsRefusal("SESSION_MOVED", "This session changed; reload.");
  }
}

type SessionStrike = Parameters<typeof recordExpertStrike>[1];

/**
 * Who is refunded in full now for this one session, or null. A paid consultation whose only session
 * this is, completed or still approved, has no make-up to wait for. A cancelled booking keeps what
 * its cancel paid, and a void whose refund already moved owes nothing more.
 */
async function sessionRefundNow(
  tx: Tx,
  occ: OverturnRow,
): Promise<SessionNoShowRefund | null> {
  if (occ.seatsSettledAt) return null;
  const session = await readSessionNoShow(tx, occ.id);
  return session &&
    session.otherSessions === 0 &&
    (session.status === "COMPLETED" || session.status === "APPROVED")
    ? session.refund
    : null;
}

/**
 * Expert absent on a consultation, decided by an operator. Where every live session is expert
 * absent the no-show claim cancels the booking, owes the full refund and writes the strike in this
 * transaction (`claimed`). Otherwise this one session is voided by the door's own void path with a
 * strike (`session`): unpaid, a booking no longer approved, or a session already voided; `refund`
 * names who is then refunded in full at once. The strike is null for a session already confirmed
 * expert absent, whose strike that write recorded.
 */
async function decideConsultationNoShow(
  tx: Tx,
  occ: OverturnRow,
  args: OverturnArgs,
  now: Date,
): Promise<
  | {
      kind: "claimed";
      result: {
        before: { completionStatus: string; outcome: OccurrenceOutcome | null };
        after: {
          completionStatus: OccurrenceCompletionStatus;
          outcome: OccurrenceOutcome;
        };
        afterCommit: () => Promise<void>;
      };
    }
  | {
      kind: "session";
      strike: SessionStrike | null;
      refund: SessionNoShowRefund | null;
    }
> {
  const consultantProfileId =
    occ.appointment.consultation?.consultationPlan.consultantProfileId;
  if (!consultantProfileId) {
    throw sessionVoidRefusal({ reason: "BOOKING_MISSING" }, now);
  }
  const strike: SessionStrike = {
    consultantProfileId,
    organizationId: occ.appointment.organizationId,
    cause: "CONSULTANT_NO_SHOW",
    appointmentId: occ.appointmentId,
    occurrenceIds: [occ.id],
  };
  if (occ.completionStatus === "VOIDED") {
    if (occ.outcome === "HOST_ABSENT" && occ.outcomeConfirmedAt !== null) {
      return { kind: "session", strike: null, refund: null };
    }
    await refuseDuringOutage(tx, occ);
    return { kind: "session", strike, refund: await sessionRefundNow(tx, occ) };
  }
  const judged = await readOperatorNoShowClaim(tx, occ.id);
  if ("bar" in judged) {
    const refusal = sessionVoidRefusal(judged.bar, now);
    if (refusal) throw refusal;
    await refuseDuringOutage(tx, occ);
    return { kind: "session", strike, refund: await sessionRefundNow(tx, occ) };
  }
  await parkAsNoShowProposal(tx, occ, args, now);
  const afterCommit = await runNoShowClaim(
    tx,
    judged.claim,
    args.actorUserId,
    now,
  );
  return {
    kind: "claimed",
    result: {
      before: { completionStatus: occ.completionStatus, outcome: occ.outcome },
      after: {
        completionStatus: OccurrenceCompletionStatus.CANCELLED,
        outcome: args.outcome,
      },
      afterCommit,
    },
  };
}

/**
 * Owes the booking's full refund in the door's transaction and settles the voided session with it,
 * so the day-14 sweep's cohort (`seatsSettledAt: null`) never holds it. Answers the drive to run
 * after the commit; the owed marker is durable, so the owed-refund sweep retries a lost drive.
 */
async function oweSessionRefund(
  tx: Tx,
  occ: OverturnRow,
  refund: SessionNoShowRefund,
  now: Date,
): Promise<() => Promise<void>> {
  const { held } = await oweSessionNoShowRefundTx(tx, refund);
  const { count } = await tx.appointmentOccurrence.updateMany({
    where: { id: occ.id, completionStatus: "VOIDED", seatsSettledAt: null },
    data: { seatsSettledAt: now },
  });
  if (count === 0) {
    throw new OpsRefusal("SESSION_MOVED", "This session changed; reload.");
  }
  return async () => {
    const failures = createRunFailureReporter("admin");
    try {
      await settleSessionNoShowRefund(refund, held, { errors: [], failures });
    } finally {
      failures.flush();
    }
  };
}

/** Overturn one past session's outcome; the status follows the outcome. */
export async function setSessionOutcome(tx: Tx, args: OverturnArgs) {
  const now = args.now ?? new Date();
  const occ = await tx.appointmentOccurrence.findUnique({
    where: { id: args.occurrenceId },
    select: OVERTURN_SELECT,
  });
  assertDecided(occ, now);
  let strike: SessionStrike | null = null;
  let refund: SessionNoShowRefund | null = null;
  if (args.outcome === "HOST_ABSENT" && occ.appointment.consultation) {
    const decided = await decideConsultationNoShow(tx, occ, args, now);
    if (decided.kind === "claimed") return decided.result;
    ({ strike, refund } = decided);
  }
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
  // Restoring a void to a non-miss: its unstarted make-up is no longer owed, cancelled in this
  // transaction; a started or held make-up still refuses the correction below.
  const makeUp =
    occ.completionStatus === "VOIDED" && to !== "VOIDED"
      ? await cancelUnstartedMakeUp(tx, {
          appointmentId: occ.appointmentId,
          sourceOccurrenceId: occ.id,
          ordinal: occ.ordinal,
          now,
          actorUserId: args.actorUserId,
        })
      : null;
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
  const voided =
    to === occ.completionStatus
      ? await relabel(tx, occ, args, now)
      : await moveStatus(tx, occ, args, to, now);
  // Once per session: the write above is a compare-and-set on the status, outcome and stamp read,
  // and a session read as already confirmed expert absent carries no strike to write.
  if (strike) await recordExpertStrike(tx, strike);
  const driveRefund = refund
    ? await oweSessionRefund(tx, occ, refund, now)
    : null;
  return {
    before: { completionStatus: occ.completionStatus, outcome: occ.outcome },
    after: { completionStatus: to, outcome: args.outcome },
    // The class void's and the cancelled make-up's notices and the owed refund's drive, once the caller's transaction commits.
    afterCommit:
      voided || makeUp?.bells.length || driveRefund
        ? async () => {
            if (voided) await flushClassVoidNotices(voided);
            if (makeUp?.bells.length) {
              await flushNotificationsAfter(
                { bells: makeUp.bells },
                "session.set-outcome.make-up-cancelled",
              );
            }
            await driveRefund?.();
          }
        : undefined,
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
  const { afterCommit, ...result } = await withAppointmentLock(
    occ.appointmentId,
    () => prisma.$transaction((tx) => setSessionOutcome(tx, args)),
  );
  await afterCommit?.();
  return result;
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
    actorUserId?: string | null;
    now?: Date;
  },
): Promise<{
  before: Prisma.InputJsonValue;
  after: { outcome: OccurrenceOutcome; outcomeConfirmedAt: string };
  afterCommit?: () => Promise<unknown>;
}> {
  const now = args.now ?? new Date();
  const { outcome } = args;
  if (!isNegativeMoneyOutcome(outcome)) {
    throw new OpsRefusal(
      "OUTCOME_NOT_CONFIRMABLE",
      "Only a host-absent, cut-short or learner-absent verdict needs a confirmation.",
    );
  }
  const proposal =
    outcome === "HOST_ABSENT"
      ? await tx.appointmentOccurrence.findFirst({
          where: { id: args.occurrenceId, ...PROPOSED_CONSULTANT_NO_SHOW },
          select: { id: true },
        })
      : null;
  if (proposal) return confirmNoShowProposal(tx, args.occurrenceId, args, now);
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
  // A confirmed class void now counts toward the exit right and the reliability flag.
  const stamped = await tx.appointmentOccurrence.findUnique({
    where: { id: args.occurrenceId },
    select: {
      completionStatus: true,
      appointmentId: true,
      appointment: { select: { classId: true } },
    },
  });
  const voided =
    stamped?.completionStatus === "VOIDED" && stamped.appointment.classId
      ? await onClassVoidConfirmed(tx, {
          appointmentId: stamped.appointmentId,
          occurrenceId: args.occurrenceId,
          confirmedAt: now,
        })
      : null;
  return {
    before: { outcome, outcomeConfirmedAt: null },
    after: { outcome, outcomeConfirmedAt: now.toISOString() },
    ...(voided && { afterCommit: () => flushClassVoidNotices(voided) }),
  };
}

/** A consultant no-show proposal: confirming it runs the no-show claim in the door's transaction, the refund after the commit. */
async function confirmNoShowProposal(
  tx: Tx,
  occurrenceId: string,
  args: { actorUserId?: string | null },
  now: Date,
) {
  const claim = await readNoShowClaim(tx, occurrenceId);
  if (!claim) {
    throw new OpsRefusal(
      "NO_SHOW_NOT_CLAIMABLE",
      "This booking no longer qualifies for the no-show refund; decide it with Set outcome.",
    );
  }
  const afterCommit = await runNoShowClaim(
    tx,
    claim,
    args.actorUserId ?? null,
    now,
  );
  return {
    before: { outcome: "HOST_ABSENT", outcomeConfirmedAt: null },
    after: {
      outcome: "HOST_ABSENT" as const,
      outcomeConfirmedAt: now.toISOString(),
    },
    afterCommit,
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
      // An applied negative verdict nobody confirmed, or a consultation's proposed no-show; other parked rows use set-outcome.
      canConfirm:
        isNegativeMoneyOutcome(row.outcome) &&
        row.outcomeConfirmedAt === null &&
        (row.completionStatus !== "UNVERIFIED" ||
          (row.outcome === "HOST_ABSENT" &&
            row.appointment.appointmentType === "CONSULTATION")),
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
