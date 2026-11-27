/**
 * #1569 — the miss predicates, in a module light enough for the money sweeps.
 * The make-up machine that owes each miss lives in class-sessions.ts.
 */

import type { OccurrenceOutcome, Prisma } from "@prisma/client";

import { classifiedReasons, REPORT_EFFECT } from "./outcome-reports";

/** A cancelled session must be made up, and HELD, within this many days. */
export const MAKEUP_WINDOW_DAYS = 14;

/**
 * #1569 — a miss is a host-cancelled session or a voided one. Either keeps its
 * row, is owed a make-up within 14 days, or a refund; one row is never both.
 */
export const MISS_WHERE = {
  OR: [
    { completionStatus: "CANCELLED", hostCancelledAt: { not: null } },
    { completionStatus: "VOIDED", voidedAt: { not: null } },
  ],
} satisfies Prisma.AppointmentOccurrenceWhereInput;

/** A miss whose make-up or refund has not happened yet. */
export const UNSETTLED_MISS = {
  ...MISS_WHERE,
  seatsSettledAt: null,
  deletedAt: null,
} satisfies Prisma.AppointmentOccurrenceWhereInput;

/**
 * An unsettled miss that holds its booking's earnings. A subscription's misses
 * do not: its earnings release per delivered tranche, and the money a miss is
 * owed is settled at plan end or by the cancel quote.
 */
export const EARNINGS_HOLDING_MISS = {
  ...UNSETTLED_MISS,
  appointment: { subscriptionId: null },
} satisfies Prisma.AppointmentOccurrenceWhereInput;

/** When the session was lost: the host's cancellation or the void. */
export const missedAt = (o: {
  hostCancelledAt?: Date | null;
  voidedAt?: Date | null;
}): Date | null => o.hostCancelledAt ?? o.voidedAt ?? null;

/** Outcomes that park an UNVERIFIED session for ops on any booking, paid or free. */
export const PARKED_OUTCOMES = [
  "INCONCLUSIVE",
  "HOST_ABSENT",
] as const satisfies readonly OccurrenceOutcome[];

/**
 * A past session parked for a human (the ops needs-human list): the sweep could
 * not judge it, the detector declined a host no-show, maintenance cut it, or a
 * paid session had nobody join or no room. Its booking neither completes nor
 * releases earnings until ops decides.
 */
export const AWAITING_HUMAN = {
  completionStatus: "UNVERIFIED",
  deletedAt: null,
  OR: [
    { outcome: { in: [...PARKED_OUTCOMES] } },
    { outcome: null, meeting: { endedReason: "maintenance" } },
    // Nobody joined or no room, on a paid booking; a free one has no money to hold and completes.
    {
      outcome: { in: ["NOBODY_JOINED", "OFFLINE"] },
      appointment: {
        payment: { some: { paymentStatus: "SUCCEEDED", deletedAt: null } },
      },
    },
  ],
} satisfies Prisma.AppointmentOccurrenceWhereInput;

/** The verdicts that forfeit, refund, strike or void on a person's account; each waits for a confirmation. */
export const NEGATIVE_MONEY_OUTCOMES = [
  "HOST_ABSENT",
  "CUT_SHORT",
  "LEARNER_ABSENT",
] as const satisfies readonly OccurrenceOutcome[];

export type NegativeMoneyOutcome = (typeof NEGATIVE_MONEY_OUTCOMES)[number];

const NEGATIVE_SET = new Set<OccurrenceOutcome>(NEGATIVE_MONEY_OUTCOMES);

export const isNegativeMoneyOutcome = (
  outcome: OccurrenceOutcome | null,
): outcome is NegativeMoneyOutcome =>
  outcome !== null && NEGATIVE_SET.has(outcome);

/**
 * When a miss's 14-day make-up window starts: the host's cancellation, or the void. A void whose
 * negative verdict waits for a confirmation starts at that confirmation, and has not started (null) before it.
 */
export const makeUpWindowStart = (o: {
  hostCancelledAt?: Date | null;
  voidedAt?: Date | null;
  outcome?: OccurrenceOutcome | null;
  outcomeConfirmedAt?: Date | null;
}): Date | null => {
  if (o.hostCancelledAt) return o.hostCancelledAt;
  if (!o.voidedAt) return null;
  return isNegativeMoneyOutcome(o.outcome ?? null)
    ? (o.outcomeConfirmedAt ?? null)
    : o.voidedAt;
};

/** The database twin of {@link makeUpWindowStart} for a void: its window started before `before`. Change both together. */
export function voidWindowStartedBefore(
  before: Date,
): Prisma.AppointmentOccurrenceWhereInput {
  return {
    voidedAt: { not: null },
    OR: [
      {
        outcome: { in: [...NEGATIVE_MONEY_OUTCOMES] },
        outcomeConfirmedAt: { lt: before },
      },
      {
        voidedAt: { lt: before },
        OR: [
          { outcome: null },
          { outcome: { notIn: [...NEGATIVE_MONEY_OUTCOMES] } },
        ],
      },
    ],
  };
}

/** Hours from a negative verdict (`outcomeAt`) to its window's close; must stay <= HOLD_PERIOD_HOURS.CONSULTATION. */
export const OUTCOME_REPORT_WINDOW_HOURS = 48;

/** A learner-absent verdict nobody confirmed holds its booking's earnings; on a subscription, every tranche of the plan. */
export const UNCONFIRMED_LEARNER_ABSENT = {
  outcome: "LEARNER_ABSENT",
  outcomeConfirmedAt: null,
  deletedAt: null,
} satisfies Prisma.AppointmentOccurrenceWhereInput;

/** A verdict the sweep applied (COMPLETED or VOIDED) that nobody has confirmed. */
const APPLIED_UNCONFIRMED = {
  deletedAt: null,
  isTentative: false,
  completionStatus: { in: ["COMPLETED", "VOIDED"] },
  outcomeConfirmedAt: null,
} satisfies Prisma.AppointmentOccurrenceWhereInput;

/** An applied negative verdict whose report window closed unconfirmed: the window-close pass judges it, ops decide a weak one. */
export function unconfirmedClosedVerdictWhere(
  now: Date,
): Prisma.AppointmentOccurrenceWhereInput {
  const closedBefore = new Date(
    now.getTime() - OUTCOME_REPORT_WINDOW_HOURS * 3_600_000,
  );
  return {
    ...APPLIED_UNCONFIRMED,
    outcome: { in: [...NEGATIVE_MONEY_OUTCOMES] },
    outcomeAt: { lt: closedBefore },
  };
}

/** When a verdict written at `outcomeAt` stops taking reports. */
export const reportWindowClosesAt = (outcomeAt: Date): Date =>
  new Date(outcomeAt.getTime() + OUTCOME_REPORT_WINDOW_HOURS * 3_600_000);

/** A linked case whose reason could move this verdict; who filed it and when is judged on the row read. */
const reportCaseWhere = (
  reasons: string[],
): Prisma.SupportCaseListRelationFilter => ({
  some: {
    deletedAt: null,
    ownershipScope: { not: "ORG_OPERATIONS" },
    flowReason: { in: reasons },
  },
});

/** An applied unconfirmed verdict an agreeing report may apply before its window closes. */
export const AGREED_VERDICT = {
  ...APPLIED_UNCONFIRMED,
  outcomeAt: { not: null },
  OR: NEGATIVE_MONEY_OUTCOMES.filter(
    (outcome) => REPORT_EFFECT[outcome].agree.length > 0,
  ).map((outcome) => ({
    outcome,
    supportCases: reportCaseWhere([...REPORT_EFFECT[outcome].agree]),
  })),
} satisfies Prisma.AppointmentOccurrenceWhereInput;

/** A consultation's host no-show, parked UNVERIFIED until its confirmation runs the no-show claim. */
export const PROPOSED_CONSULTANT_NO_SHOW = {
  deletedAt: null,
  isTentative: false,
  completionStatus: "UNVERIFIED",
  outcome: "HOST_ABSENT",
  outcomeConfirmedAt: null,
  appointment: { consultationId: { not: null } },
} satisfies Prisma.AppointmentOccurrenceWhereInput;

/** A proposed consultant no-show whose window closed, or that the learner's report agrees with. */
export function confirmableNoShowWhere(
  now: Date,
): Prisma.AppointmentOccurrenceWhereInput {
  const closedBefore = new Date(
    now.getTime() - OUTCOME_REPORT_WINDOW_HOURS * 3_600_000,
  );
  return {
    ...PROPOSED_CONSULTANT_NO_SHOW,
    OR: [
      { outcomeAt: { lt: closedBefore } },
      {
        outcomeAt: { not: null },
        supportCases: reportCaseWhere([...REPORT_EFFECT.HOST_ABSENT.agree]),
      },
    ],
  };
}

/** An unsettled void whose negative verdict nobody confirmed: no refund path may settle it yet. */
export const UNCONFIRMED_NEGATIVE_VOID = {
  completionStatus: "VOIDED",
  deletedAt: null,
  seatsSettledAt: null,
  outcome: { in: [...NEGATIVE_MONEY_OUTCOMES] },
  outcomeConfirmedAt: null,
} satisfies Prisma.AppointmentOccurrenceWhereInput;

/** A void the 14-day refund may settle: any negative verdict on it is confirmed. Explicit about a null outcome, which NOT would read as NULL. */
export const SETTLEABLE_VOID_VERDICT = {
  OR: [
    { outcome: null },
    { outcome: { notIn: [...NEGATIVE_MONEY_OUTCOMES] } },
    { outcomeConfirmedAt: { not: null } },
  ],
} satisfies Prisma.AppointmentOccurrenceWhereInput;

/** The in-memory twin of SETTLEABLE_VOID_VERDICT; change both together. */
export const isSettleableVoidVerdict = (o: {
  outcome: OccurrenceOutcome | null;
  outcomeConfirmedAt: Date | null;
}): boolean =>
  !isNegativeMoneyOutcome(o.outcome) || o.outcomeConfirmedAt !== null;

/** An applied unconfirmed verdict with a dispute or agreement filed against it: ops see both statements. */
export const REPORTED_VERDICT = {
  ...APPLIED_UNCONFIRMED,
  OR: NEGATIVE_MONEY_OUTCOMES.map((outcome) => ({
    outcome,
    supportCases: reportCaseWhere(classifiedReasons(outcome)),
  })),
} satisfies Prisma.AppointmentOccurrenceWhereInput;

/** The ops needs-human list: the above, a paid trial that was voided (D4), a closed unconfirmed verdict and a reported one. */
export function needsHumanWhere(
  now: Date,
): Prisma.AppointmentOccurrenceWhereInput {
  return {
    deletedAt: null,
    isTentative: false,
    OR: [
      AWAITING_HUMAN,
      {
        completionStatus: "VOIDED",
        seatsSettledAt: null,
        appointment: { trial: { paymentId: { not: null } } },
      },
      unconfirmedClosedVerdictWhere(now),
      REPORTED_VERDICT,
    ],
  };
}

/** A session parked for ops longer than this escalates: its booking's settlement is waiting on it. */
export const NEEDS_HUMAN_ESCALATE_DAYS = 7;

const agedCutoff = (now: Date) =>
  new Date(now.getTime() - NEEDS_HUMAN_ESCALATE_DAYS * 24 * 3_600_000);

/** Parked for ops more than {@link NEEDS_HUMAN_ESCALATE_DAYS}, from the verdict or else the call's end. */
export function agedNeedsHumanWhere(
  now: Date,
): Prisma.AppointmentOccurrenceWhereInput {
  const cutoff = agedCutoff(now);
  return {
    AND: [
      needsHumanWhere(now),
      {
        OR: [
          { outcomeAt: { lt: cutoff } },
          { outcomeAt: null, endsAt: { lt: cutoff } },
        ],
      },
    ],
  };
}

/** The same age test as {@link agedNeedsHumanWhere}, for one row already read. */
export function isAgedNeedsHuman(
  row: { outcomeAt: Date | null; endsAt: Date },
  now: Date,
): boolean {
  return (row.outcomeAt ?? row.endsAt) < agedCutoff(now);
}
