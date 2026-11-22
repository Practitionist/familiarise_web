/**
 * Confirmed consultant no-shows cancel and refund consultations using the shared
 * session-outcome verdict; multi-session partial refunds are excluded.
 */

import prisma from "../../lib/prisma";
import type { PrismaLike } from "../../lib/prisma";
import { reportStandingFinding } from "../../lib/observability/standing-finding";
import { settleOccurrenceAttendance } from "../../lib/meetings/settle-attendance";
import {
  AppointmentStatus,
  CancellationReason,
  PaymentStatus,
  OccurrenceCompletionStatus,
  type OccurrenceOutcome,
  type Prisma,
} from "@prisma/client";
import {
  notifyAppointmentCancelled,
  notifyRefundProcessed,
} from "../../lib/novu/service";
import { notificationScope } from "../../lib/novu/workflows";
import { notificationHref } from "../../lib/novu/resolve-href";
import {
  EMAIL_BUDGET_MS,
  refundOnItsWay,
  sendAppointmentCancelledEmail,
  sendRefundProcessedEmail,
} from "../../lib/email";
import {
  driveRefundOwed,
  stampOwedOrHeld,
  type OwedRefundAlreadyHeld,
  type RefundOwedMarker,
} from "@/lib/payments/operations/refund-owed";
import { withCronLock } from "@/lib/cron/with-cron-lock";
import { startDeadline } from "@/lib/cron/run-deadline";
import {
  createRunFailureReporter,
  type RunFailureReporter,
} from "@/lib/observability/run-failures";
import {
  CANCELLABLE_FROM,
  transitionConsultationRequest,
  transitionOccurrenceCompletion,
} from "@/lib/booking/transitions";
import { IllegalTransitionError } from "@/lib/enterprise/transitions";
import { NO_SHOW_GRACE_MINUTES } from "@/lib/booking/attendance";
import {
  classifySessionOutcome,
  type OutageWindow,
  type PresenceInterval,
} from "@/lib/booking/session-outcome";
import { readOutageWindows } from "@/lib/booking/session-outcome-sweep";
import { LIVE_SLOT_WHERE } from "@/lib/booking/cancellation-scope";
import { recordSystemErrorSafe } from "@/lib/enterprise/system-events";
import { recordExpertStrike } from "@/lib/booking/expert-reliability";

export interface NoShowResult {
  success: boolean;
  detected: number;
  refunded: number;
  /** Candidates skipped because Stream's record of a judged session is not stored yet; the next run retries. */
  unsettled: number;
  /** No-shows whose payment already owed another door's refund, so this added nothing; top up by hand. */
  refundsAlreadyOwed: OwedRefundAlreadyHeld[];
  errors: string[];
  timestamp: string;
}

/**
 * Candidates per bite when the caller passes none. Oldest `updatedAt` first;
 * the CAS claim in `claimConsultantNoShow` moves a consultation out of the
 * cohort (APPROVED/SCHEDULED only), and a candidate a bite read but left in
 * the cohort is excluded from the run's later bites by id.
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
  const pastDeadline = startDeadline(opts?.startedAt);
  // #476 — locked at the core so every entry shares one mutual exclusion.
  // Fail-closed: this is a money job (auto-refund), so per with-cron-lock.ts it
  // refuses to run without a real Redis lock rather than risk a silent unlocked
  // double-run. The CAS claim + refundPayment's refundable-balance guard remain
  // the correctness backstop; the lock is the mutual-exclusion layer on top.
  return withCronLock(
    "detect-consultant-no-shows",
    { failMode: "closed" },
    () => detectConsultantNoShowsUnlocked(maxCandidates, pastDeadline),
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

// A decided or parked sibling makes the booking ops-owned, so this job must
// not touch it. A settled incident void is history, not a decision on its rebook.
const DECIDED_OR_PARKED = {
  deletedAt: null,
  OR: [
    { outcome: { not: null } },
    { completionStatus: OccurrenceCompletionStatus.UNVERIFIED },
  ],
  NOT: {
    completionStatus: OccurrenceCompletionStatus.VOIDED,
    outcome: "PLATFORM_OUTAGE",
    seatsSettledAt: { not: null },
  },
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

/** The in-memory twin of DECIDED_OR_PARKED; change both together. */
function isOpsOwnedSibling(occurrence: {
  deletedAt: Date | null;
  completionStatus: OccurrenceCompletionStatus;
  outcome: OccurrenceOutcome | null;
  seatsSettledAt: Date | null;
}): boolean {
  if (occurrence.deletedAt !== null) return false;
  if (
    occurrence.completionStatus === OccurrenceCompletionStatus.VOIDED &&
    occurrence.outcome === "PLATFORM_OUTAGE" &&
    occurrence.seatsSettledAt !== null
  ) {
    return false;
  }
  return (
    occurrence.outcome !== null ||
    occurrence.completionStatus === OccurrenceCompletionStatus.UNVERIFIED
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
          payment: {
            select: {
              id: true,
              amount: true,
              currency: true,
              paymentStatus: true,
            },
          },
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
type NoShowParty = {
  consultantUserId: string;
  consulteeUserId: string;
  appointmentId: string;
  occurrenceIds: string[];
  /** The judged session that was HOST_ABSENT; the strike is scoped to it. */
  strikeOccurrenceId: string;
  startsAt: Date;
};
type PaidPayment = NonNullable<
  NoShowCandidate["appointment"]
>["payment"][number];

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
  opts: { now?: Date; failures?: RunFailureReporter } = {},
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

// Returns the party ids when `consultation` is a confirmed CONSULTANT no-show,
// or null to skip. The verdict is `classifySessionOutcome` over Stream's settled
// record, the same one the end + 1 h sweep writes, so the two jobs cannot
// disagree: some session is HOST_ABSENT and the consultant was present in none.
// Neither-showed and consultee-no-show cases are excluded — no consultant-fault
// refund there.
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

  const outcomes = judged.map(
    (o) =>
      classifySessionOutcome({
        startsAt: o.startsAt,
        endsAt: o.endsAt,
        hostUserIds: [consultantUserId],
        intervals: intervals.get(o.id) ?? [],
        meeting: o.meeting,
        maintenanceWindows: outages,
      }).outcome,
  );
  const hostNeverPresent = outcomes.every((o) => HOST_NEVER_PRESENT.has(o));
  if (!outcomes.includes("HOST_ABSENT") || !hostNeverPresent) return null;
  const strikeOccurrenceId = judged.find(
    (_, i) => outcomes[i] === "HOST_ABSENT",
  )?.id;
  if (!strikeOccurrenceId) return null;

  return {
    consultantUserId,
    consulteeUserId,
    appointmentId,
    occurrenceIds: judged.map((o) => o.id),
    strikeOccurrenceId,
    startsAt: judged[0].startsAt,
  };
}

const HOST_NEVER_PRESENT = new Set<OccurrenceOutcome>([
  "HOST_ABSENT",
  "NOBODY_JOINED",
  "OFFLINE",
]);

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

// Claim it: CAS active → CANCELLED. This is the idempotency gate — the detection
// query only reads APPROVED/SCHEDULED, so once flipped a later run (or the
// auto-complete cron) cannot re-process it. A concurrent cancel landing here wins
// and this returns false → skip. On a successful claim we also reflect the
// no-show on the judged slots (no NO_SHOW slot status exists — schema frozen;
// CANCELLED is the closest; only undecided SCHEDULED slots move).
async function claimConsultantNoShow(
  consultationId: string,
  appointmentId: string,
  occurrenceIds: string[],
  strikeOccurrenceId: string,
  owed: RefundOwedMarker | null,
  strike: { consultantProfileId: string; organizationId: string | null },
  failures: RunFailureReporter,
): Promise<{ held: OwedRefundAlreadyHeld | null } | false> {
  try {
    return await prisma.$transaction(async (tx) => {
      // #1493 — route through the CAS helper so this cancel writes a
      // BookingStatusHistory row like every other status change; the bare
      // updateMany left no timeline entry for the no-show path.
      await transitionConsultationRequest(tx, {
        where: {
          id: consultationId,
          appointment: {
            occurrences: {
              some: { id: { in: occurrenceIds }, ...JUDGEABLE_SLOT },
              none: DECIDED_OR_PARKED,
            },
          },
        },
        to: AppointmentStatus.CANCELLED,
        fromIn: CANCELLABLE_FROM,
        actorUserId: null,
        reason: "#471 consultant no-show — auto-cancelled + refunded",
        data: {
          cancellationReason: CancellationReason.CONSULTANT_UNAVAILABLE,
          cancellationNotes:
            "#471 consultant no-show — auto-cancelled + refunded",
          cancelledAt: new Date(),
        },
      });

      // #1583 A-P0-05 — through the helper, tombstoned, with a history row;
      // the from-set is the one the raw updateMany carried.
      const moved = await transitionOccurrenceCompletion(tx, {
        where: { id: { in: occurrenceIds }, ...JUDGEABLE_SLOT },
        to: OccurrenceCompletionStatus.CANCELLED,
        fromIn: [OccurrenceCompletionStatus.SCHEDULED],
        data: { deletedAt: new Date() },
        allowZero: false,
        actorUserId: null,
        reason: "consultant no-show",
      });
      // Zero rows or a partial move means a concurrent writer took a session;
      // throw so the parent cancel rolls back with it.
      if (moved !== occurrenceIds.length) {
        throw new IllegalTransitionError(
          "AppointmentOccurrence",
          OccurrenceCompletionStatus.CANCELLED,
        );
      }
      // The full refund the no-show owes commits with the claim; one another
      // door already owes is reported instead (first writer wins).
      const held = owed ? await stampOwedOrHeld(tx, owed) : null;
      await recordExpertStrike(tx, {
        ...strike,
        cause: "CONSULTANT_NO_SHOW",
        appointmentId,
        occurrenceIds: [strikeOccurrenceId],
      });
      return { held };
    });
  } catch (error) {
    // Zero rows matched (parent or occurrences) means someone else moved it
    // between the scan and this claim — the skip branch at the call site.
    if (error instanceof IllegalTransitionError) {
      failures.add(
        "detect-consultant-no-shows",
        new Error("No-show claim lost its CAS; row skipped"),
        { consultationId, appointmentId },
        { expected: true },
      );
      return false;
    }
    throw error;
  }
}

/** The full refund a consultant no-show owes, under the arm's own key. */
function noShowRefundOwed(paymentId: string): RefundOwedMarker {
  return {
    paymentId,
    amountPaise: null,
    // Distinct from every expiry arm's key, so a later refund of the same
    // payment for another reason is a real ALREADY_FULLY_REFUNDED.
    key: `consultant-no-show:${paymentId}`,
    reason: "consultant no-show (#471)",
  };
}

function paidPaymentOf(consultation: NoShowCandidate): PaidPayment | undefined {
  return consultation.appointment?.payment?.find(
    (p) => p.paymentStatus === PaymentStatus.SUCCEEDED,
  );
}

/**
 * Drive the full refund the claim stamped, through the booking front door so
 * gateway, org-funded and credit rails each settle correctly. The key makes a
 * second run (a lost lock) and the retry sweep one refund with this one; a
 * failure stays on the marker and is surfaced for ops.
 */
async function refundNoShowConsultation(
  consultation: NoShowCandidate,
  errors: string[],
  failures: RunFailureReporter,
): Promise<{
  refundedPaise: number;
  succeeded: boolean;
  paidPayment: PaidPayment | undefined;
}> {
  const paidPayment = paidPaymentOf(consultation);
  if (!paidPayment) {
    const msg = `No refundable payment for no-show consultation ${consultation.id}`;
    console.warn(`   ⚠️ ${msg}`);
    errors.push(msg);
    return { refundedPaise: 0, succeeded: false, paidPayment: undefined };
  }
  const outcome = await driveRefundOwed(noShowRefundOwed(paidPayment.id));
  if (outcome.kind === "refunded" || outcome.kind === "replayed") {
    console.log(
      `   💸 Refunded ${outcome.refund.amountRefundedPaise}p via ${outcome.refund.rail ?? "an earlier run"}`,
    );
    return {
      refundedPaise: outcome.refund.amountRefundedPaise,
      succeeded: true,
      paidPayment,
    };
  }
  if (outcome.kind === "settled") {
    return { refundedPaise: 0, succeeded: true, paidPayment };
  }
  const refundErr =
    outcome.kind === "failed"
      ? outcome.error
      : new Error(`payment ${paidPayment.id} has an open dispute`);
  const msg = `Failed to refund no-show consultation ${consultation.id} (payment ${paidPayment.id}): ${refundErr}`;
  console.error(`   ❌ ${msg}`);
  errors.push(msg);
  // Ops parity with every other refund-failure path: a durable signal, awaited
  // so the job's exit cannot drop it.
  const refundError =
    refundErr instanceof Error ? refundErr : new Error(String(refundErr));
  failures.add("detect-consultant-no-shows.refund-failed", refundError, {
    consultationId: consultation.id,
    paymentId: paidPayment.id,
  });
  await recordSystemErrorSafe({
    organizationId: null,
    category: "PAYMENT",
    summary: `No-show refund failed for consultation ${consultation.id}`,
    err: refundError,
    context: { paymentId: paidPayment.id },
    skipSentry: true,
  });
  return { refundedPaise: 0, succeeded: false, paidPayment };
}

// #1654 — awaited notifications (staged, then attempted) reusing the Novu service.
async function notifyNoShowParties(
  consultation: NoShowCandidate,
  party: NoShowParty,
  refundedPaise: number,
  paidPayment: PaidPayment | undefined,
): Promise<void> {
  const consultantName =
    consultation.consultationPlan?.consultantProfile?.user?.name ??
    "Consultant";
  const consulteeName = consultation.requestedBy?.user?.name ?? "Consultee";
  const planTitle = consultation.consultationPlan?.title ?? "Consultation";
  const noShowOrgId = consultation.appointment?.organizationId ?? null;
  const dashboardUrl = notificationHref(noShowOrgId, "appointments");

  await notifyAppointmentCancelled(
    [party.consultantUserId, party.consulteeUserId],
    {
      ...notificationScope(noShowOrgId),
      appointmentId: party.appointmentId,
      appointmentType: "consultation",
      consultantName,
      consulteeName,
      planTitle,
      dashboardUrl,
      cancelledBy: "system",
      reason: "Consultant did not attend the scheduled session.",
    },
  ).catch((e) => console.error(`[no-show] cancellation notify failed:`, e));

  // #1653 — the email twin of the bell above; the refund line goes to the
  // consultee alone. The sender never throws, so the catch is the same
  // belt-and-braces the bell wears.
  await sendAppointmentCancelledEmail(
    {
      appointmentId: party.appointmentId,
      userIds: [party.consultantUserId, party.consulteeUserId],
      startsAt: party.startsAt,
      cancelledBy: "Familiarise",
      reason: "Consultant did not attend the scheduled session.",
      refundText:
        refundedPaise > 0 && paidPayment
          ? refundOnItsWay(refundedPaise, paidPayment.currency)
          : undefined,
      refundUserIds: [party.consulteeUserId],
      dashboardUrl,
    },
    EMAIL_BUDGET_MS.JOB,
  ).catch((e) => console.error(`[no-show] cancellation email failed:`, e));

  if (refundedPaise > 0 && paidPayment) {
    await notifyRefundProcessed(party.consulteeUserId, {
      ...notificationScope(noShowOrgId),
      amount: refundedPaise,
      currency: paidPayment.currency,
      reason: "consultant no-show",
      appointmentType: "consultation",
      consultantName,
      dashboardUrl,
    }).catch((e) => console.error(`[no-show] refund notify failed:`, e));
    // #1653 — the email twin; the sender never throws.
    await sendRefundProcessedEmail(
      {
        userId: party.consulteeUserId,
        paymentId: paidPayment.id,
        amountPaise: refundedPaise,
        currency: paidPayment.currency,
        planTitle,
      },
      { budgetMs: EMAIL_BUDGET_MS.JOB },
    );
  }
}

interface NoShowTally {
  detected: number;
  refunded: number;
  unsettled: Array<{ consultationId: string }>;
  refundsAlreadyOwed: OwedRefundAlreadyHeld[];
  errors: string[];
  failures: RunFailureReporter;
}

/** One candidate through the consultant-fault pass; failures land in `tally.errors`. */
async function handleNoShowCandidate(
  consultation: NoShowCandidate,
  outages: OutageWindow[],
  graceCutoff: Date,
  tally: NoShowTally,
): Promise<void> {
  try {
    // Money moves only on Stream's settled record; an unsettled session is retried next run.
    const intervals = await settledJudgedAttendance(consultation, graceCutoff, {
      failures: tally.failures,
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

    tally.detected++;
    console.log(`\n🚫 Consultant no-show: consultation ${consultation.id}`);
    console.log(`   Plan: ${consultation.consultationPlan?.title}`);

    const paid = paidPaymentOf(consultation);
    const claimed = await claimConsultantNoShow(
      consultation.id,
      party.appointmentId,
      party.occurrenceIds,
      party.strikeOccurrenceId,
      paid ? noShowRefundOwed(paid.id) : null,
      {
        consultantProfileId: consultation.consultationPlan.consultantProfileId,
        organizationId: consultation.appointment?.organizationId ?? null,
      },
      tally.failures,
    );
    if (!claimed) {
      console.log(`   ⏭️ Skipped — status changed since scan`);
      tally.detected--;
      return;
    }
    if (claimed.held) {
      // Another door's refund is the one owed; the no-show added nothing to it.
      tally.refundsAlreadyOwed.push(claimed.held);
      await notifyNoShowParties(
        consultation,
        party,
        0,
        paidPaymentOf(consultation),
      );
      return;
    }

    const { refundedPaise, succeeded, paidPayment } =
      await refundNoShowConsultation(
        consultation,
        tally.errors,
        tally.failures,
      );
    if (succeeded) tally.refunded++;

    await notifyNoShowParties(consultation, party, refundedPaise, paidPayment);
  } catch (error) {
    const msg = `Failed to handle candidate consultation ${consultation.id}: ${error}`;
    console.error(`   ❌ ${msg}`);
    tally.errors.push(msg);
  }
}

async function detectConsultantNoShowsUnlocked(
  maxCandidates: number,
  pastDeadline: () => boolean,
): Promise<NoShowResult> {
  const tally: NoShowTally = {
    detected: 0,
    refunded: 0,
    unsettled: [],
    refundsAlreadyOwed: [],
    errors: [],
    failures: createRunFailureReporter("bookings"),
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
  console.log(`   Detected: ${tally.detected}`);
  console.log(`   Refunded: ${tally.refunded}`);
  console.log(`   Waiting on Stream's record: ${tally.unsettled.length}`);
  if (errors.length > 0) {
    console.log("\n⚠️ Errors:");
    errors.forEach((e) => console.log(`   - ${e}`));
  }

  return {
    success: errors.length === 0,
    detected: tally.detected,
    refunded: tally.refunded,
    unsettled: tally.unsettled.length,
    refundsAlreadyOwed: tally.refundsAlreadyOwed,
    errors,
    timestamp: new Date().toISOString(),
  };
}

export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}
