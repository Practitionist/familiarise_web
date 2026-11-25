/**
 * A consultant no-show's money step, run only once its proposed HOST_ABSENT
 * verdict is confirmed (the window-close pass or ops): one transaction cancels
 * the consultation and its proposed sessions, stamps the full refund owed and
 * records the strike; the refund is then driven through the booking front door.
 */

import {
  AppointmentStatus,
  CancellationReason,
  OccurrenceCompletionStatus,
  PaymentStatus,
  type OccurrenceOutcome,
  type Prisma,
} from "@prisma/client";

import prisma, { type Tx } from "@/lib/prisma";
import {
  notifyAppointmentCancelled,
  notifyRefundProcessed,
} from "@/lib/novu/service";
import { notificationScope } from "@/lib/novu/workflows";
import { notificationHref } from "@/lib/novu/resolve-href";
import {
  EMAIL_BUDGET_MS,
  refundOnItsWay,
  sendAppointmentCancelledEmail,
  sendRefundProcessedEmail,
} from "@/lib/email";
import {
  driveRefundOwed,
  stampOwedOrHeld,
  type OwedRefundAlreadyHeld,
  type RefundOwedMarker,
} from "@/lib/payments/operations/refund-owed";
import type { RunFailureReporter } from "@/lib/observability/run-failures";
import { recordSystemErrorSafe } from "@/lib/enterprise/system-events";
import { IllegalTransitionError } from "@/lib/enterprise/transitions";
import {
  CANCELLABLE_FROM,
  transitionConsultationRequest,
  transitionOccurrenceCompletion,
} from "./transitions";
import { recordExpertStrike } from "./expert-reliability";
import { readOverlappingOutages } from "./outage-windows";

// A decided, held or parked sibling makes the booking ops-owned. A settled incident void is history, not a decision on its rebook.
export const DECIDED_OR_PARKED = {
  deletedAt: null,
  OR: [
    { outcome: { not: null } },
    { completionStatus: OccurrenceCompletionStatus.UNVERIFIED },
    { completionStatus: OccurrenceCompletionStatus.COMPLETED },
  ],
  NOT: {
    completionStatus: OccurrenceCompletionStatus.VOIDED,
    outcome: "PLATFORM_OUTAGE",
    seatsSettledAt: { not: null },
  },
} satisfies Prisma.AppointmentOccurrenceWhereInput;

/** The in-memory twin of DECIDED_OR_PARKED; change both together. */
export function isOpsOwnedSibling(occurrence: {
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
    occurrence.completionStatus === OccurrenceCompletionStatus.UNVERIFIED ||
    occurrence.completionStatus === OccurrenceCompletionStatus.COMPLETED
  );
}

/**
 * A session of the proposal still standing: parked UNVERIFIED as expert-absent, unconfirmed.
 * A sibling nobody joined, or with no room, is not one: that booking is an operator's to decide.
 */
const STANDING_PROPOSAL = {
  deletedAt: null,
  completionStatus: OccurrenceCompletionStatus.UNVERIFIED,
  outcome: "HOST_ABSENT",
  outcomeConfirmedAt: null,
} satisfies Prisma.AppointmentOccurrenceWhereInput;

/** The in-memory twin of STANDING_PROPOSAL. */
function isStanding(o: ClaimOccurrence): boolean {
  return (
    o.deletedAt === null &&
    o.completionStatus === OccurrenceCompletionStatus.UNVERIFIED &&
    o.outcome === "HOST_ABSENT" &&
    o.outcomeConfirmedAt === null
  );
}

/** A live session outside the proposal vetoes the claim; the last arm is a parked row with no outcome, which NOT reads as NULL. */
const CLAIM_VETO = {
  OR: [
    {
      deletedAt: null,
      isTentative: false,
      completionStatus: OccurrenceCompletionStatus.SCHEDULED,
    },
    { AND: [DECIDED_OR_PARKED, { NOT: STANDING_PROPOSAL }] },
    {
      deletedAt: null,
      completionStatus: OccurrenceCompletionStatus.UNVERIFIED,
      outcome: null,
    },
  ],
} satisfies Prisma.AppointmentOccurrenceWhereInput;

/** The in-memory twin of CLAIM_VETO. */
function vetoesClaim(o: ClaimOccurrence): boolean {
  if (o.deletedAt !== null) return false;
  if (o.completionStatus === OccurrenceCompletionStatus.SCHEDULED) {
    return !o.isTentative;
  }
  return isOpsOwnedSibling(o) && !isStanding(o);
}

const PAID = {
  paymentStatus: PaymentStatus.SUCCEEDED,
  deletedAt: null,
} satisfies Prisma.PaymentWhereInput;

const CLAIM_SELECT = {
  id: true,
  status: true,
  consultationPlan: {
    select: {
      title: true,
      consultantProfileId: true,
      consultantProfile: {
        select: { userId: true, user: { select: { name: true } } },
      },
    },
  },
  requestedBy: { select: { userId: true, user: { select: { name: true } } } },
  appointment: {
    select: {
      id: true,
      organizationId: true,
      payment: {
        where: PAID,
        orderBy: { createdAt: "asc" },
        select: { id: true, currency: true },
      },
      occurrences: {
        orderBy: { startsAt: "asc" },
        select: {
          id: true,
          startsAt: true,
          endsAt: true,
          deletedAt: true,
          isTentative: true,
          completionStatus: true,
          outcome: true,
          outcomeConfirmedAt: true,
          seatsSettledAt: true,
          meeting: { select: { presences: { select: { userId: true } } } },
        },
      },
    },
  },
} satisfies Prisma.ConsultationSelect;

type ClaimRow = Prisma.ConsultationGetPayload<{ select: typeof CLAIM_SELECT }>;
type ClaimOccurrence = NonNullable<
  ClaimRow["appointment"]
>["occurrences"][number];

/** What a confirmed no-show cancels, refunds and strikes, and who hears of it. */
export interface NoShowClaim {
  consultationId: string;
  appointmentId: string;
  organizationId: string | null;
  /** The confirmed HOST_ABSENT session; the strike names it. */
  strikeOccurrenceId: string;
  /** Every standing session of the proposal, the strike's included. */
  occurrenceIds: string[];
  /** Their booked times, which an outage declared since the verdict must not overlap. */
  windows: { startsAt: Date; endsAt: Date }[];
  consultantProfileId: string;
  consultantUserId: string;
  consulteeUserId: string;
  consultantName: string;
  consulteeName: string;
  planTitle: string;
  startsAt: Date;
  payment: { id: string; currency: string };
}

/** Why a booking cannot take the no-show claim; the ops door names it to the operator. */
export type NoShowClaimBar =
  | { reason: "BOOKING_MISSING" }
  | { reason: "NOT_APPROVED"; status: AppointmentStatus }
  | { reason: "UNPAID" }
  | { reason: "NOT_PROPOSED" }
  | {
      reason: "SIBLING";
      sibling: Pick<
        ClaimOccurrence,
        "id" | "startsAt" | "completionStatus" | "outcome"
      >;
    }
  | { reason: "CONSULTANT_PRESENT" };

export type NoShowJudgement = { claim: NoShowClaim } | { bar: NoShowClaimBar };

/**
 * Whether the claim may run on this booking now: a live, paid, APPROVED consultation with no
 * vetoing sibling. By "evidence" (the pass and ops Confirm) the strike session must also be a
 * standing proposal and the consultant have no stay on any proposed session. By "operator" the
 * verdict is the operator's own: the door parks the strike session as the proposal, and the
 * stored presence is not asked.
 */
export function judgeNoShowClaim(
  row: ClaimRow,
  strikeOccurrenceId: string,
  by: "evidence" | "operator",
): NoShowJudgement {
  const consultantUserId = row.consultationPlan?.consultantProfile?.userId;
  const consulteeUserId = row.requestedBy?.userId;
  const appointment = row.appointment;
  if (!consultantUserId || !consulteeUserId || !appointment) {
    return { bar: { reason: "BOOKING_MISSING" } };
  }
  if (row.status !== AppointmentStatus.APPROVED) {
    return { bar: { reason: "NOT_APPROVED", status: row.status } };
  }
  const payment = appointment.payment[0];
  if (!payment) return { bar: { reason: "UNPAID" } };
  const strike = appointment.occurrences.find(
    (o) => o.id === strikeOccurrenceId,
  );
  if (
    !strike ||
    strike.isTentative ||
    strike.deletedAt !== null ||
    (by === "evidence" && !isStanding(strike))
  ) {
    return { bar: { reason: "NOT_PROPOSED" } };
  }
  const sibling = appointment.occurrences.find(
    (o) => o.id !== strike.id && vetoesClaim(o),
  );
  if (sibling) {
    return {
      bar: {
        reason: "SIBLING",
        sibling: {
          id: sibling.id,
          startsAt: sibling.startsAt,
          completionStatus: sibling.completionStatus,
          outcome: sibling.outcome,
        },
      },
    };
  }
  const proposal = appointment.occurrences.filter(
    (o) => o.id === strike.id || isStanding(o),
  );
  // Any stay of the consultant on a proposed session, even after the booked end, is not a no-show.
  if (
    by === "evidence" &&
    proposal.some((o) =>
      (o.meeting?.presences ?? []).some((p) => p.userId === consultantUserId),
    )
  ) {
    return { bar: { reason: "CONSULTANT_PRESENT" } };
  }
  return {
    claim: {
      consultationId: row.id,
      appointmentId: appointment.id,
      organizationId: appointment.organizationId,
      strikeOccurrenceId: strike.id,
      occurrenceIds: proposal.map((o) => o.id),
      windows: proposal.map((o) => ({
        startsAt: o.startsAt,
        endsAt: o.endsAt,
      })),
      consultantProfileId: row.consultationPlan.consultantProfileId,
      consultantUserId,
      consulteeUserId,
      consultantName:
        row.consultationPlan.consultantProfile.user?.name ?? "Consultant",
      consulteeName: row.requestedBy.user?.name ?? "Consultee",
      planTitle: row.consultationPlan.title ?? "Consultation",
      startsAt: proposal[0].startsAt,
      payment,
    },
  };
}

/**
 * The claim the detector's rules allow on this booking now, or null: a live paid
 * consultation whose every live session is a standing expert-absent proposal the consultant has no stay in.
 */
export function noShowClaimOf(
  row: ClaimRow,
  strikeOccurrenceId: string,
): NoShowClaim | null {
  const judged = judgeNoShowClaim(row, strikeOccurrenceId, "evidence");
  return "claim" in judged ? judged.claim : null;
}

/** Reads the booking behind a proposed session and judges whether its claim may run. */
export async function readNoShowClaim(
  db: Pick<Tx, "consultation">,
  occurrenceId: string,
): Promise<NoShowClaim | null> {
  const row = await db.consultation.findFirst({
    where: { appointment: { occurrences: { some: { id: occurrenceId } } } },
    select: CLAIM_SELECT,
  });
  return row ? noShowClaimOf(row, occurrenceId) : null;
}

/** An operator's own expert-absent verdict on a session of the booking: the claim, or why it cannot run. */
export async function readOperatorNoShowClaim(
  db: Pick<Tx, "consultation">,
  occurrenceId: string,
): Promise<NoShowJudgement> {
  const row = await db.consultation.findFirst({
    where: { appointment: { occurrences: { some: { id: occurrenceId } } } },
    select: CLAIM_SELECT,
  });
  return row
    ? judgeNoShowClaim(row, occurrenceId, "operator")
    : { bar: { reason: "BOOKING_MISSING" } };
}

/** An outage now overlaps a proposed session: the claim rolls back and the next pass judges it weak. */
export class NoShowDuringOutageError extends Error {
  constructor(readonly consultationId: string) {
    super(
      `An outage overlaps consultation ${consultationId}'s proposed no-show`,
    );
    this.name = "NoShowDuringOutageError";
  }
}

/** The full refund a consultant no-show owes, under the arm's own key. */
export function noShowRefundOwed(paymentId: string): RefundOwedMarker {
  return {
    paymentId,
    amountPaise: null,
    // Distinct from every expiry arm's key, so a later refund of the same
    // payment for another reason is a real ALREADY_FULLY_REFUNDED.
    key: `consultant-no-show:${paymentId}`,
    reason: "consultant no-show (#471)",
  };
}

/**
 * The claim, on the caller's transaction: CAS the consultation to CANCELLED,
 * then its proposed sessions (the strike's stamped confirmed), stamp the owed
 * refund and write the strike. Any CAS miss throws IllegalTransitionError, and an
 * outage now overlapping the sessions NoShowDuringOutageError, so nothing commits;
 * `guard` narrows the strike session's CAS further.
 */
export async function claimNoShowTx(
  tx: Tx,
  claim: NoShowClaim,
  opts: {
    now: Date;
    guard?: Prisma.AppointmentOccurrenceWhereInput;
    actorUserId: string | null;
  },
): Promise<{ held: OwedRefundAlreadyHeld | null }> {
  const { now, actorUserId } = opts;
  const strike = {
    id: claim.strikeOccurrenceId,
    ...STANDING_PROPOSAL,
  } satisfies Prisma.AppointmentOccurrenceWhereInput;
  await transitionConsultationRequest(tx, {
    where: {
      id: claim.consultationId,
      appointment: {
        payment: { some: PAID },
        occurrences: { some: strike, none: CLAIM_VETO },
      },
    },
    to: AppointmentStatus.CANCELLED,
    fromIn: CANCELLABLE_FROM,
    actorUserId,
    reason: "#471 consultant no-show — auto-cancelled + refunded",
    data: {
      cancellationReason: CancellationReason.CONSULTANT_UNAVAILABLE,
      cancellationNotes: "#471 consultant no-show — auto-cancelled + refunded",
      cancelledAt: now,
    },
  });
  // Read after the cancel's row lock, so an incident or maintenance window committed while the claim waited is seen.
  if ((await readOverlappingOutages(tx, claim.windows)).length > 0) {
    throw new NoShowDuringOutageError(claim.consultationId);
  }
  await transitionOccurrenceCompletion(tx, {
    where: { AND: [opts.guard ?? {}, strike] },
    to: OccurrenceCompletionStatus.CANCELLED,
    fromIn: [OccurrenceCompletionStatus.UNVERIFIED],
    data: { deletedAt: now, outcomeConfirmedAt: now },
    allowZero: false,
    actorUserId,
    reason: "consultant no-show",
  });
  const rest = claim.occurrenceIds.filter(
    (id) => id !== claim.strikeOccurrenceId,
  );
  if (rest.length > 0) {
    const moved = await transitionOccurrenceCompletion(tx, {
      where: { id: { in: rest }, ...STANDING_PROPOSAL },
      to: OccurrenceCompletionStatus.CANCELLED,
      fromIn: [OccurrenceCompletionStatus.UNVERIFIED],
      data: { deletedAt: now },
      allowZero: true,
      actorUserId,
      reason: "consultant no-show",
    });
    // A session another writer took since the read rolls the whole claim back.
    if (moved !== rest.length) {
      throw new IllegalTransitionError(
        "AppointmentOccurrence",
        OccurrenceCompletionStatus.CANCELLED,
      );
    }
  }
  // One another door already owes is reported instead (first writer wins).
  const held = await stampOwedOrHeld(tx, noShowRefundOwed(claim.payment.id));
  await recordExpertStrike(tx, {
    consultantProfileId: claim.consultantProfileId,
    organizationId: claim.organizationId,
    cause: "CONSULTANT_NO_SHOW",
    appointmentId: claim.appointmentId,
    occurrenceIds: [claim.strikeOccurrenceId],
  });
  return { held };
}

/**
 * Drives the full refund the claim stamped, through the booking front door so
 * gateway, org-funded and credit rails each settle correctly. The key makes a
 * replay and the retry sweep one refund with this one; a failure stays on the
 * marker and is surfaced for ops.
 */
async function refundNoShow(
  claim: NoShowClaim,
  report: { errors: string[]; failures: RunFailureReporter },
): Promise<{ refundedPaise: number; succeeded: boolean }> {
  const outcome = await driveRefundOwed(noShowRefundOwed(claim.payment.id));
  if (outcome.kind === "refunded" || outcome.kind === "replayed") {
    return {
      refundedPaise: outcome.refund.amountRefundedPaise,
      succeeded: true,
    };
  }
  if (outcome.kind === "settled") return { refundedPaise: 0, succeeded: true };
  const refundErr =
    outcome.kind === "failed"
      ? outcome.error
      : new Error(`payment ${claim.payment.id} has an open dispute`);
  report.errors.push(
    `Failed to refund no-show consultation ${claim.consultationId} (payment ${claim.payment.id}): ${refundErr}`,
  );
  const refundError =
    refundErr instanceof Error ? refundErr : new Error(String(refundErr));
  report.failures.add("detect-consultant-no-shows.refund-failed", refundError, {
    consultationId: claim.consultationId,
    paymentId: claim.payment.id,
  });
  // A durable signal, awaited so the run's exit cannot drop it.
  await recordSystemErrorSafe({
    organizationId: null,
    category: "PAYMENT",
    summary: `No-show refund failed for consultation ${claim.consultationId}`,
    err: refundError,
    context: { paymentId: claim.payment.id },
    skipSentry: true,
  });
  return { refundedPaise: 0, succeeded: false };
}

/** Awaited notifications (staged, then attempted): the cancellation to both, the refund to the learner. */
async function notifyNoShowParties(
  claim: NoShowClaim,
  refundedPaise: number,
): Promise<void> {
  const dashboardUrl = notificationHref(claim.organizationId, "appointments");
  const recipients = [claim.consultantUserId, claim.consulteeUserId];
  await notifyAppointmentCancelled(recipients, {
    ...notificationScope(claim.organizationId),
    appointmentId: claim.appointmentId,
    appointmentType: "consultation",
    consultantName: claim.consultantName,
    consulteeName: claim.consulteeName,
    planTitle: claim.planTitle,
    dashboardUrl,
    cancelledBy: "system",
    reason: "Consultant did not attend the scheduled session.",
  }).catch((e) => console.error(`[no-show] cancellation notify failed:`, e));

  // The email twin of the bell; the refund line goes to the learner alone.
  await sendAppointmentCancelledEmail(
    {
      appointmentId: claim.appointmentId,
      userIds: recipients,
      startsAt: claim.startsAt,
      cancelledBy: "Familiarise",
      reason: "Consultant did not attend the scheduled session.",
      refundText:
        refundedPaise > 0
          ? refundOnItsWay(refundedPaise, claim.payment.currency)
          : undefined,
      refundUserIds: [claim.consulteeUserId],
      dashboardUrl,
    },
    EMAIL_BUDGET_MS.JOB,
  ).catch((e) => console.error(`[no-show] cancellation email failed:`, e));

  if (refundedPaise > 0) {
    await notifyRefundProcessed(claim.consulteeUserId, {
      ...notificationScope(claim.organizationId),
      amount: refundedPaise,
      currency: claim.payment.currency,
      reason: "consultant no-show",
      appointmentType: "consultation",
      consultantName: claim.consultantName,
      dashboardUrl,
    }).catch((e) => console.error(`[no-show] refund notify failed:`, e));
    await sendRefundProcessedEmail(
      {
        userId: claim.consulteeUserId,
        paymentId: claim.payment.id,
        amountPaise: refundedPaise,
        currency: claim.payment.currency,
        planTitle: claim.planTitle,
      },
      { budgetMs: EMAIL_BUDGET_MS.JOB },
    );
  }
}

/** After the claim commits: drive the refund unless another door's owes it, then tell both sides. */
export async function settleClaimedNoShow(
  claim: NoShowClaim,
  held: OwedRefundAlreadyHeld | null,
  report: { errors: string[]; failures: RunFailureReporter },
): Promise<{ refunded: boolean }> {
  if (held) {
    await notifyNoShowParties(claim, 0);
    return { refunded: false };
  }
  const { refundedPaise, succeeded } = await refundNoShow(claim, report);
  await notifyNoShowParties(claim, refundedPaise);
  return { refunded: succeeded };
}

export type NoShowConfirmation =
  | { kind: "claimed"; refunded: boolean; held: OwedRefundAlreadyHeld | null }
  /** The booking no longer meets the detector's rules; it stays parked for ops. */
  | { kind: "declined" }
  /** A writer moved the booking between the read and the claim, or the guard held it. */
  | { kind: "lost" }
  /** An outage declared since the pass's read overlaps it; the next pass judges it weak. */
  | { kind: "outage" };

/** The window-close pass's door: claim a confirmed proposal in its own transaction, then refund and notify. */
export async function confirmConsultantNoShow(
  occurrenceId: string,
  opts: {
    now: Date;
    guard: Prisma.AppointmentOccurrenceWhereInput;
    errors: string[];
    failures: RunFailureReporter;
  },
): Promise<NoShowConfirmation> {
  const claim = await readNoShowClaim(prisma, occurrenceId);
  if (!claim) return { kind: "declined" };
  let held: OwedRefundAlreadyHeld | null;
  try {
    ({ held } = await prisma.$transaction((tx) =>
      claimNoShowTx(tx, claim, {
        now: opts.now,
        guard: opts.guard,
        actorUserId: null,
      }),
    ));
  } catch (error) {
    if (error instanceof IllegalTransitionError) return { kind: "lost" };
    if (error instanceof NoShowDuringOutageError) return { kind: "outage" };
    throw error;
  }
  const { refunded } = await settleClaimedNoShow(claim, held, opts);
  return { kind: "claimed", refunded, held };
}
