/**
 * Confirmed consultant no-shows cancel and refund consultations using the shared
 * session-outcome verdict; multi-session partial refunds are excluded.
 */

import prisma from "../../lib/prisma";
import type { PrismaLike } from "../../lib/prisma";
import { reportStandingFinding } from "../../lib/observability/standing-finding";
import {
  getCallPresenceEvidence,
  type CallPresenceEvidence,
} from "../../lib/stream/call-presence";
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
} from "@/lib/booking/session-outcome";
import { readOutageWindows } from "@/lib/booking/session-outcome-sweep";
import { isDeadOccurrence } from "@/lib/appointments/occurrences";
import { LIVE_SLOT_WHERE } from "@/lib/booking/cancellation-scope";
import { recordSystemErrorSafe } from "@/lib/enterprise/system-events";
import { recordExpertStrike } from "@/lib/booking/expert-reliability";

export interface NoShowResult {
  success: boolean;
  detected: number;
  refunded: number;
  /**
   * Candidates the attendance rows called a no-show and Stream did not.
   *
   * Non-zero means a `call.session_participant_joined` delivery was lost: the
   * consultant WAS in the call and our rows do not know it. Every one of these
   * is a refund that would have been issued wrongly before this check existed.
   */
  contradicted: number;
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
// #1834 — a session the outcome sweep decided or parked for ops (D2) is no
// longer this job's to cancel and refund; cohort and CAS both exclude it.
const DECIDED_OR_PARKED = {
  deletedAt: null,
  // An incident-voided original is history, not a decision on its rebook.
  completionStatus: { not: OccurrenceCompletionStatus.VOIDED },
  OR: [
    { outcome: { not: null } },
    { completionStatus: OccurrenceCompletionStatus.UNVERIFIED },
  ],
} satisfies Prisma.AppointmentOccurrenceWhereInput;

// Shared by the candidate read and the ticker's idle probe.
function noShowCandidateWhere(graceCutoff: Date) {
  return {
    status: { in: [AppointmentStatus.APPROVED, AppointmentStatus.SCHEDULED] },
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
            include: {
              meeting: {
                include: { attendances: { select: { userId: true } } },
              },
              // #1569 — the intervals the shared classifier reads.
              presences: {
                select: { userId: true, joinedAt: true, leftAt: true },
              },
            },
          },
        },
      },
    },
  });
}

type NoShowCandidate = Awaited<ReturnType<typeof findNoShowCandidates>>[number];

/** The sessions the verdict is about: live ones, never an incident-voided original. */
function judgedSessions(consultation: NoShowCandidate) {
  return (consultation.appointment?.occurrences ?? []).filter(
    (o) =>
      !isDeadOccurrence(o) &&
      o.completionStatus !== OccurrenceCompletionStatus.VOIDED,
  );
}
type NoShowParty = {
  consultantUserId: string;
  consulteeUserId: string;
  appointmentId: string;
};
type PaidPayment = NonNullable<
  NoShowCandidate["appointment"]
>["payment"][number];

// Returns the party ids when `consultation` is a confirmed CONSULTANT no-show,
// or null to skip. #1569 — the verdict is `classifySessionOutcome`, the same
// one the end + 1 h sweep writes, so the two jobs cannot disagree (#1504): some
// session is HOST_ABSENT and the consultant was present in none of them.
// Neither-showed and consultee-no-show cases are excluded — no consultant-fault
// refund there.
function evaluateConsultantNoShow(
  consultation: NoShowCandidate,
  outages: OutageWindow[],
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

  const outcomes = judgedSessions(consultation).map(
    (o) =>
      classifySessionOutcome({
        startsAt: o.startsAt,
        endsAt: o.endsAt,
        hostUserIds: [consultantUserId],
        intervals: o.presences,
        meeting: o.meeting,
        // Stream corroboration is its own refusal below.
        report: null,
        maintenanceWindows: outages,
      }).outcome,
  );
  const hostNeverPresent = outcomes.every((o) => HOST_NEVER_PRESENT.has(o));
  if (!outcomes.includes("HOST_ABSENT") || !hostNeverPresent) return null;

  return { consultantUserId, consulteeUserId, appointmentId };
}

const HOST_NEVER_PRESENT = new Set<OccurrenceOutcome>([
  "HOST_ABSENT",
  "NOBODY_JOINED",
  "OFFLINE",
]);

/**
 * Does Stream's own record of the call contradict a no-show finding?
 *
 * `evaluateConsultantNoShow` infers absence from a MISSING attendance row, and
 * those rows come from per-participant webhook deliveries that can be lost
 * independently. Losing only the consultant's produces a textbook false
 * positive: consultee present, consultant "absent", full refund against someone
 * who was there.
 *
 * Stream is an independent witness that does not depend on our webhook pipeline
 * having worked. Two distinct participants in a 1:1 consultation means both
 * parties were present, whatever our rows say.
 *
 * Returns the reason to REFUSE, or null to proceed. Refusing on missing evidence
 * is deliberate: this function guards an automatic, customer-visible refund, and
 * "we could not check" is not "it definitely happened". The cost of refusing
 * wrongly is a support ticket; the cost of refunding wrongly is re-charging a
 * customer by hand.
 */
export async function refusalFromStreamEvidence(
  consultation: NoShowCandidate,
  lookup: PresenceLookup = makePresenceLookup(),
): Promise<string | null> {
  const callIds = judgedSessions(consultation)
    .map((slot) => slot.meeting?.streamCallId)
    .filter((id): id is string => !!id);

  if (callIds.length === 0) return "no Stream call on any slot";

  for (const callId of callIds) {
    const evidence = await lookup(callId);
    if (!evidence) return `Stream has no report for ${callId}`;
    if (evidence.unique >= 2) {
      return `Stream saw ${evidence.unique} distinct participants on ${callId}`;
    }
  }
  return null;
}

/** One console finding per run, recorded only when the set has a consultation not already recorded in the window. */
async function reportOncePerRun(
  message: string,
  entries: Array<{ consultationId: string; refusal?: string }>,
): Promise<void> {
  if (entries.length === 0) return;
  await reportStandingFinding({
    key: `detect-consultant-no-shows:${message}`,
    ids: entries.map((e) => e.consultationId),
    message,
  });
}

/** A per-run cache over `getCallPresenceEvidence`, so one call id is fetched once inside the held lock. */
function makePresenceLookup() {
  const cache = new Map<string, Promise<CallPresenceEvidence | null>>();
  return (callId: string) => {
    const hit = cache.get(callId);
    if (hit) return hit;
    const pending = getCallPresenceEvidence(callId);
    cache.set(callId, pending);
    return pending;
  };
}

type PresenceLookup = ReturnType<typeof makePresenceLookup>;

// Claim it: CAS active → CANCELLED. This is the idempotency gate — the detection
// query only reads APPROVED/SCHEDULED, so once flipped a later run (or the
// auto-complete cron) cannot re-process it. A concurrent cancel landing here wins
// and this returns false → skip. On a successful claim we also reflect the
// no-show on the slots (no NO_SHOW slot status exists — schema frozen, #471 —
// CANCELLED is the closest; only undecided SCHEDULED slots move, #1834).
async function claimConsultantNoShow(
  consultationId: string,
  appointmentId: string,
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
          appointment: { occurrences: { none: DECIDED_OR_PARKED } },
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

      const claimedSessions = await tx.appointmentOccurrence.findMany({
        where: {
          appointmentId,
          deletedAt: null,
          outcome: null,
          completionStatus: OccurrenceCompletionStatus.SCHEDULED,
        },
        select: { id: true },
      });
      // #1583 A-P0-05 — through the helper, tombstoned, with a history row;
      // the from-set is the one the raw updateMany carried.
      await transitionOccurrenceCompletion(tx, {
        where: { appointmentId, deletedAt: null, outcome: null },
        to: OccurrenceCompletionStatus.CANCELLED,
        fromIn: [OccurrenceCompletionStatus.SCHEDULED],
        data: { deletedAt: new Date() },
        // Zero live occurrences means a concurrent writer took the booking's
        // sessions first; the parent cancel above rolls back with this throw
        // rather than committing a no-show that claimed no session.
        allowZero: false,
        actorUserId: null,
        reason: "consultant no-show",
      });
      // The full refund the no-show owes commits with the claim; one another
      // door already owes is reported instead (first writer wins).
      const held = owed ? await stampOwedOrHeld(tx, owed) : null;
      await recordExpertStrike(tx, {
        ...strike,
        cause: "CONSULTANT_NO_SHOW",
        appointmentId,
        occurrenceIds: claimedSessions.map((o) => o.id),
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
      startsAt: consultation.appointment?.occurrences?.[0]?.startsAt ?? null,
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
  contradicted: number;
  refusals: Array<{ consultationId: string; refusal: string }>;
  refundsAlreadyOwed: OwedRefundAlreadyHeld[];
  errors: string[];
  failures: RunFailureReporter;
}

/** One candidate through the consultant-fault pass; failures land in `tally.errors`. */
async function handleNoShowCandidate(
  consultation: NoShowCandidate,
  outages: OutageWindow[],
  presence: PresenceLookup,
  tally: NoShowTally,
): Promise<void> {
  try {
    const party = evaluateConsultantNoShow(consultation, outages);
    if (!party) return;

    // Corroborate against Stream before moving money. Our attendance rows are
    // webhook-derived and each party's arrives separately, so the predicate
    // above can be satisfied by a LOST DELIVERY rather than a real absence.
    const refusal = await refusalFromStreamEvidence(consultation, presence);
    if (refusal) {
      tally.contradicted++;
      console.log(
        `\n🛑 Not a no-show after all: consultation ${consultation.id} — ${refusal}`,
      );
      // Worth an alert rather than a log line. Either a webhook was lost — in
      // which case attendance data is wrong platform-wide and this is the only
      // place it surfaces — or the detector's own predicate needs revisiting.
      tally.refusals.push({ consultationId: consultation.id, refusal });
      return;
    }

    tally.detected++;
    console.log(`\n🚫 Consultant no-show: consultation ${consultation.id}`);
    console.log(`   Plan: ${consultation.consultationPlan?.title}`);

    const paid = paidPaymentOf(consultation);
    const claimed = await claimConsultantNoShow(
      consultation.id,
      party.appointmentId,
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
    contradicted: 0,
    refusals: [],
    refundsAlreadyOwed: [],
    errors: [],
    failures: createRunFailureReporter("bookings"),
  };
  const { errors } = tally;
  const presence = makePresenceLookup();

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
        await handleNoShowCandidate(consultation, outages, presence, tally);
      }

      if (candidates.length < maxCandidates) break;
    }
  } finally {
    tally.failures.flush();
    await reportOncePerRun(
      "Consultant no-show refused on Stream evidence",
      tally.refusals,
    );
  }

  console.log("\n📊 No-Show Summary:");
  console.log(`   Detected: ${tally.detected}`);
  console.log(`   Refunded: ${tally.refunded}`);
  console.log(`   Refused on Stream evidence: ${tally.contradicted}`);
  if (errors.length > 0) {
    console.log("\n⚠️ Errors:");
    errors.forEach((e) => console.log(`   - ${e}`));
  }

  return {
    success: errors.length === 0,
    detected: tally.detected,
    refunded: tally.refunded,
    contradicted: tally.contradicted,
    refundsAlreadyOwed: tally.refundsAlreadyOwed,
    errors,
    timestamp: new Date().toISOString(),
  };
}

export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}
