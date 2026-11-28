/**
 * A consultant no-show is proposed, never claimed, here: the judged sessions are
 * parked UNVERIFIED with their verdicts, and the money step
 * (`lib/booking/consultant-no-show.ts`) runs only once HOST_ABSENT is confirmed.
 * Multi-session partial refunds are excluded.
 */

import prisma from "../../lib/prisma";
import type { PrismaLike } from "../../lib/prisma";
import { reportStandingFinding } from "../../lib/observability/standing-finding";
import { settleOccurrenceAttendance } from "../../lib/meetings/settle-attendance";
import {
  AppointmentStatus,
  PaymentStatus,
  OccurrenceCompletionStatus,
  type OccurrenceOutcome,
  type Prisma,
} from "@prisma/client";
import { withCronLock } from "@/lib/cron/with-cron-lock";
import {
  startDeadline,
  SWEEP_START_DEADLINE_MS,
} from "@/lib/cron/run-deadline";
import {
  createRunFailureReporter,
  type RunFailureReporter,
} from "@/lib/observability/run-failures";
import { transitionOccurrenceCompletion } from "@/lib/booking/transitions";
import { IllegalTransitionError } from "@/lib/enterprise/transitions";
import { NO_SHOW_GRACE_MINUTES } from "@/lib/booking/attendance";
import {
  classifySessionOutcome,
  type OutageWindow,
  type PresenceInterval,
  type SessionOutcomeVerdict,
} from "@/lib/booking/session-outcome";
import { readOutageWindows } from "@/lib/booking/session-outcome-sweep";
import { LIVE_SLOT_WHERE } from "@/lib/booking/cancellation-scope";
import {
  DECIDED_OR_PARKED,
  isOpsOwnedSibling,
} from "@/lib/booking/consultant-no-show";

export interface NoShowResult {
  success: boolean;
  /** Consultations whose sessions were proposed as a consultant no-show this run. */
  detected: number;
  /** Candidates skipped because Stream's record of a judged session is not stored yet; the next run retries. */
  unsettled: number;
  errors: string[];
  timestamp: string;
}

/**
 * Candidates per bite when the caller passes none. Oldest `updatedAt` first;
 * the proposal moves a consultation's judged sessions out of the cohort
 * (SCHEDULED only), and a candidate a bite read but left in the cohort is
 * excluded from the run's later bites by id.
 */
const MAX_CANDIDATES_PER_BITE = 10;

export async function detectConsultantNoShows(opts?: {
  maxCandidates?: number;
  /** When the request began (ms epoch); defaults to this call. */
  startedAt?: number;
}): Promise<NoShowResult> {
  const maxCandidates =
    opts?.maxCandidates && opts.maxCandidates > 0
      ? Math.floor(opts.maxCandidates)
      : MAX_CANDIDATES_PER_BITE;
  const startedAt = opts?.startedAt ?? Date.now();
  const pastDeadline = startDeadline(startedAt);
  // A candidate started near that cutoff still finishes its Stream reads inside the ticker's abort.
  const settleDeadlineAt = startedAt + SWEEP_START_DEADLINE_MS;
  // #476 — locked at the core so every entry shares one mutual exclusion.
  // Fail-closed, as a money-adjacent job; the per-session CAS stays the backstop.
  return withCronLock(
    "detect-consultant-no-shows",
    { failMode: "closed" },
    () =>
      detectConsultantNoShowsUnlocked(
        maxCandidates,
        pastDeadline,
        settleDeadlineAt,
      ),
  );
}

// Candidate consultations: still active (not already cancelled/completed),
// paid, whose slots have all ended past the grace window and where a
// Meeting actually happened (the call took place — a precondition for
// "the consultee showed up but the consultant didn't").
// Only a live, undecided SCHEDULED slot is this job's to judge.
const JUDGEABLE_SLOT = {
  deletedAt: null,
  completionStatus: OccurrenceCompletionStatus.SCHEDULED,
  outcome: null,
  isTentative: false,
} satisfies Prisma.AppointmentOccurrenceWhereInput;

/** The in-memory twin of JUDGEABLE_SLOT; change both together. */
function isJudgeableOccurrence(
  occurrence: {
    deletedAt: Date | null;
    completionStatus: OccurrenceCompletionStatus;
    outcome: OccurrenceOutcome | null;
    isTentative: boolean;
    endsAt: Date;
  },
  graceCutoff: Date,
): boolean {
  return (
    occurrence.deletedAt === null &&
    occurrence.completionStatus === OccurrenceCompletionStatus.SCHEDULED &&
    occurrence.outcome === null &&
    !occurrence.isTentative &&
    occurrence.endsAt.getTime() < graceCutoff.getTime()
  );
}

// Shared by the candidate read and the ticker's idle probe.
function noShowCandidateWhere(graceCutoff: Date) {
  return {
    status: AppointmentStatus.APPROVED,
    appointment: {
      payment: {
        some: {
          paymentStatus: PaymentStatus.SUCCEEDED,
          // E2E-audit P1 fix — amount > 0 used to exclude fully
          // credit-funded (free_) bookings, so a consultant no-showing a
          // credits-paid session silently skipped BOTH the cancellation
          // and the credit restoration. The front door routes those to the
          // credits rail on its own.
          deletedAt: null,
        },
      },
      occurrences: {
        every: { endsAt: { lt: graceCutoff } },
        some: {
          ...LIVE_SLOT_WHERE,
          endsAt: { lt: graceCutoff },
          meeting: { isNot: null },
        },
        none: DECIDED_OR_PARKED,
      },
    },
  } satisfies Prisma.ConsultationWhereInput;
}

const noShowGraceCutoff = (nowMs: number) =>
  new Date(nowMs - NO_SHOW_GRACE_MINUTES * 60 * 1000);

export async function hasConsultantNoShowWork(
  db: PrismaLike,
  now: Date,
  outOfTime: () => boolean,
): Promise<boolean> {
  if (outOfTime()) return true;
  const row = await db.consultation.findFirst({
    where: noShowCandidateWhere(noShowGraceCutoff(now.getTime())),
    select: { id: true },
  });
  return row !== null;
}

function findNoShowCandidates(
  graceCutoff: Date,
  maxCandidates: number,
  seen: string[],
) {
  return prisma.consultation.findMany({
    orderBy: { updatedAt: "asc" },
    take: maxCandidates,
    where: {
      ...(seen.length > 0 ? { id: { notIn: seen } } : {}),
      ...noShowCandidateWhere(graceCutoff),
    },
    include: {
      consultationPlan: {
        select: {
          title: true,
          consultantProfileId: true,
          consultantProfile: {
            select: { userId: true, user: { select: { name: true } } },
          },
        },
      },
      requestedBy: {
        select: { userId: true, user: { select: { name: true } } },
      },
      appointment: {
        include: {
          occurrences: {
            orderBy: { startsAt: "asc" },
            include: { meeting: true },
          },
        },
      },
    },
  });
}

type NoShowCandidate = Awaited<ReturnType<typeof findNoShowCandidates>>[number];
/** Each judged session's verdict, which the proposal writes. */
type NoShowParty = {
  verdicts: { occurrenceId: string; verdict: SessionOutcomeVerdict }[];
};

/** The sessions this job may judge: live, undecided and past the grace window. */
function judgedOccurrences(consultation: NoShowCandidate, graceCutoff: Date) {
  return (consultation.appointment?.occurrences ?? []).filter((o) =>
    isJudgeableOccurrence(o, graceCutoff),
  );
}

/**
 * Stream's stored record of every judged session, settled now where it can be;
 * null when any is not settled, which this job treats as INCONCLUSIVE: no refund, no strike.
 */
export async function settledJudgedAttendance(
  consultation: NoShowCandidate,
  graceCutoff: Date,
  opts: {
    now?: Date;
    failures?: RunFailureReporter;
    /** Epoch ms by which every Stream read must answer; a read past it leaves the candidate unsettled. */
    deadlineAt?: number;
  } = {},
): Promise<Map<string, PresenceInterval[]> | null> {
  const intervals = new Map<string, PresenceInterval[]>();
  for (const occurrence of judgedOccurrences(consultation, graceCutoff)) {
    // No room means no call: the classifier answers OFFLINE without a read.
    if (!occurrence.meeting) continue;
    const settled = await settleOccurrenceAttendance(
      {
        occurrenceId: occurrence.id,
        endsAt: occurrence.endsAt,
        meeting: occurrence.meeting,
      },
      opts,
    );
    if (settled.kind !== "settled") return null;
    intervals.set(occurrence.id, settled.intervals);
  }
  return intervals;
}

// Returns the judged sessions' verdicts when `consultation` is a CONSULTANT no-show,
// or null to skip. The verdict is `classifySessionOutcome` over Stream's settled
// record, the same one the end + 1 h sweep writes, so the two jobs cannot
// disagree: every judged session is HOST_ABSENT and the consultant was present in none.
// A booking with a neither-showed, no-room or consultee-no-show session is excluded:
// no automatic consultant-fault refund there.
export function evaluateConsultantNoShow(
  consultation: NoShowCandidate,
  outages: OutageWindow[],
  graceCutoff: Date,
  intervals: ReadonlyMap<string, readonly PresenceInterval[]>,
): NoShowParty | null {
  const consultantUserId =
    consultation.consultationPlan?.consultantProfile?.userId;
  const consulteeUserId = consultation.requestedBy?.userId;
  const appointmentId = consultation.appointment?.id;
  if (!consultantUserId || !consulteeUserId || !appointmentId) {
    // Cannot attribute presence without both user ids, and an undefined
    // appointmentId would drop the where-filter on the slot updateMany below
    // (Prisma ignores undefined) — skip, don't guess.
    return null;
  }

  const occurrences = consultation.appointment?.occurrences ?? [];
  // A decided or parked sibling means the sweep or a human owns the booking;
  // the cohort and claim CAS carry the same veto.
  if (occurrences.some(isOpsOwnedSibling)) return null;
  const judged = judgedOccurrences(consultation, graceCutoff);
  if (judged.length === 0) return null;
  // Any settled presence of the consultant on a judged call, even after the booked end, is not a no-show.
  if (
    judged.some((o) =>
      (intervals.get(o.id) ?? []).some((i) => i.userId === consultantUserId),
    )
  ) {
    return null;
  }

  const verdicts = judged.map((o) => ({
    occurrenceId: o.id,
    verdict: classifySessionOutcome({
      startsAt: o.startsAt,
      endsAt: o.endsAt,
      hostUserIds: [consultantUserId],
      intervals: intervals.get(o.id) ?? [],
      meeting: o.meeting,
      maintenanceWindows: outages,
    }),
  }));
  // Automatic only when every judged session is expert-absent; any other sibling leaves the booking to the slot pass and ops.
  if (!verdicts.every((v) => v.verdict.outcome === "HOST_ABSENT")) return null;
  return { verdicts };
}

/** One console finding per run, recorded only when the set has a consultation not already recorded in the window. */
async function reportOncePerRun(
  message: string,
  entries: Array<{ consultationId: string }>,
): Promise<void> {
  if (entries.length === 0) return;
  await reportStandingFinding({
    key: `detect-consultant-no-shows:${message}`,
    ids: entries.map((e) => e.consultationId),
    message,
  });
}

/**
 * Propose it: every judged session moves SCHEDULED -> UNVERIFIED with its own
 * verdict and an unconfirmed stamp, by one CAS each in one transaction, so a
 * session another writer took rolls the whole proposal back. No money moves.
 */
async function proposeConsultantNoShow(
  consultation: NoShowCandidate,
  party: NoShowParty,
  now: Date,
): Promise<boolean> {
  try {
    await prisma.$transaction(async (tx) => {
      for (const { occurrenceId, verdict } of party.verdicts) {
        await transitionOccurrenceCompletion(tx, {
          where: { id: occurrenceId, ...JUDGEABLE_SLOT },
          to: OccurrenceCompletionStatus.UNVERIFIED,
          fromIn: [OccurrenceCompletionStatus.SCHEDULED],
          data: {
            outcome: verdict.outcome,
            outcomeAt: now,
            outcomeConfirmedAt: null,
            deliveredMinutes: verdict.deliveredMinutes,
            lostMinutes: verdict.lostMinutes,
          },
          allowZero: false,
          actorUserId: null,
          reason: `consultant-no-show:proposed:${verdict.outcome}`,
          organizationId: consultation.appointment?.organizationId ?? null,
        });
      }
    });
    return true;
  } catch (error) {
    if (error instanceof IllegalTransitionError) return false;
    throw error;
  }
}

interface NoShowTally {
  detected: number;
  unsettled: Array<{ consultationId: string }>;
  errors: string[];
  failures: RunFailureReporter;
  /** Every candidate's Stream reads must answer by the end of the run's start budget. */
  settleDeadlineAt: number;
}

/** One candidate through the consultant-fault pass; failures land in `tally.errors`. */
async function handleNoShowCandidate(
  consultation: NoShowCandidate,
  outages: OutageWindow[],
  graceCutoff: Date,
  tally: NoShowTally,
): Promise<void> {
  try {
    // A verdict is proposed only on Stream's settled record; an unsettled session is retried next run.
    const intervals = await settledJudgedAttendance(consultation, graceCutoff, {
      failures: tally.failures,
      deadlineAt: tally.settleDeadlineAt,
    });
    if (!intervals) {
      tally.unsettled.push({ consultationId: consultation.id });
      return;
    }
    const party = evaluateConsultantNoShow(
      consultation,
      outages,
      graceCutoff,
      intervals,
    );
    if (!party) return;

    if (!(await proposeConsultantNoShow(consultation, party, new Date()))) {
      console.log(`   ⏭️ Skipped — a session changed since scan`);
      return;
    }
    tally.detected++;
    console.log(
      `\n🚫 Consultant no-show proposed: consultation ${consultation.id}`,
    );
  } catch (error) {
    const msg = `Failed to handle candidate consultation ${consultation.id}: ${error}`;
    console.error(`   ❌ ${msg}`);
    tally.errors.push(msg);
  }
}

async function detectConsultantNoShowsUnlocked(
  maxCandidates: number,
  pastDeadline: () => boolean,
  settleDeadlineAt: number,
): Promise<NoShowResult> {
  const tally: NoShowTally = {
    detected: 0,
    unsettled: [],
    errors: [],
    failures: createRunFailureReporter("bookings"),
    settleDeadlineAt,
  };
  const { errors } = tally;

  const graceCutoff = noShowGraceCutoff(Date.now());

  console.log("🔍 Scanning for consultant no-shows...");
  console.log(
    `   Grace window: ${NO_SHOW_GRACE_MINUTES} min after session end`,
  );
  console.log(`   Bite: ${maxCandidates} candidate(s)`);

  // #1569 — the classifier's maintenance hold turns a host-absent verdict inconclusive.
  const outages = await readOutageWindows(
    prisma,
    new Date(graceCutoff.getTime() - 7 * 86_400_000),
  );
  const seen: string[] = [];

  // Bite after bite until a short cohort or the drain deadline; the cron lock
  // is held by the caller for the whole loop.
  // TODO(#1319): subscriptions are multi-session — a single-session consultant
  // no-show is a partial refund of one session out of N, not a whole-booking
  // cancel. Deferred pending per-session refund design; consultations (the
  // single-session exclusive case) are handled above.

  // Findings collected by earlier bites are reported even if a later bite throws.
  try {
    while (!pastDeadline()) {
      const candidates = await findNoShowCandidates(
        graceCutoff,
        maxCandidates,
        seen,
      );
      seen.push(...candidates.map((c) => c.id));
      console.log(`Found ${candidates.length} paid, ended candidates to check`);

      for (const consultation of candidates) {
        if (pastDeadline()) break;
        await handleNoShowCandidate(consultation, outages, graceCutoff, tally);
      }

      if (candidates.length < maxCandidates) break;
    }
  } finally {
    tally.failures.flush();
    await reportOncePerRun(
      "Consultant no-show waiting on Stream's settled record",
      tally.unsettled,
    );
  }

  console.log("\n📊 No-Show Summary:");
  console.log(`   Proposed: ${tally.detected}`);
  console.log(`   Waiting on Stream's record: ${tally.unsettled.length}`);
  if (errors.length > 0) {
    console.log("\n⚠️ Errors:");
    errors.forEach((e) => console.log(`   - ${e}`));
  }

  return {
    success: errors.length === 0,
    detected: tally.detected,
    unsettled: tally.unsettled.length,
    errors,
    timestamp: new Date().toISOString(),
  };
}

export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}
