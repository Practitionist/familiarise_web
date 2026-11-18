/**
 * Trial cancellation — soft-cancel + refund (#1009).
 *
 * Both cancel paths used to hard-delete the trial's appointment to free the
 * slot. `Payment.appointment` is `onDelete: Cascade`, so once paid trials
 * shipped (#1046) that delete destroyed the payment row with it: no refund, no
 * ledger entry, nothing left to reconcile against the gateway.
 *
 * The delete was never what freed the slot. `buildOccupiedAppointmentFilter`
 * counts a trial as occupying only while SCHEDULED or AWAITING_PAYMENT, so the
 * status transition alone releases it — which is exactly what the hourly expiry
 * job (`scripts/trials/expire-unpaid-trials.ts`) has always relied on. This
 * module makes the interactive paths behave like that job, and adds the refund
 * the paid path needs.
 */

import {
  type CancelSide,
  trialCancelRefundReason,
} from "@/lib/payments/operations/refund-cause";
import * as Sentry from "@sentry/nextjs";
import { transitionParticipant } from "@/lib/booking/participants";
import { transitionOccurrenceCompletion } from "@/lib/booking/transitions";
import {
  readCancelWindowState,
  resolveBookingRefundContext,
} from "@/lib/booking/cancellation-scope";
import { cancelWindowRefusal } from "@/lib/booking/session-window";
import type { TrialCancelBody } from "@/schemas/trials";
import type { Refusal } from "@/lib/errors/refusal";
import { PaymentStatus, OccurrenceCompletionStatus } from "@prisma/client";

import prisma, { type PrismaLike, type Tx } from "@/lib/prisma";
import {
  REFUNDABLE_BALANCE_SELECT,
  refundableBalancePaise,
} from "@/lib/payments/refundable-balance";
import { quoteBookingRefund } from "@/lib/payments/operations/cancellation-policy";
import {
  driveRefundOwed,
  type RefundOwedMarker,
} from "@/lib/payments/operations/refund-owed";
import {
  fundingRailForIntent,
  type FundingRail,
} from "@/lib/payments/funding-rail";
import {
  computeHoldUntil,
  holdHoursFor,
  stampConsultantHolds,
} from "@/lib/payments/payouts/earnings-hold";

export type TrialRefundOutcome = {
  refundPct: number;
  amountRefundedPaise: number;
  /**
   * Which rail returned the money, or null when nothing moved. A trial can be
   * funded through any of the three, and only the gateway rail reaches the
   * buyer — a credit restoration is invisible as a rupee amount, so without this
   * the response reads as a refund of nothing.
   */
  rail?: FundingRail | null;
  /** Set when the gateway leg failed; the cancellation still stands. */
  failed?: boolean;
  /** The gateway is still settling the refund: notices say it has started. */
  pending?: boolean;
};

/**
 * Retire the appointment behind a cancelled trial.
 *
 * Soft-delete rather than delete: the tombstone (`Appointment.deletedAt`,
 * mirrored on the slots) is the sanctioned removal for anything money rows hang
 * off, and it keeps the trial ↔ appointment link readable for support and
 * reconciliation. Callers must have already moved the trial out of
 * SCHEDULED/AWAITING_PAYMENT, or the slot stays occupied.
 */
export async function softCancelTrialAppointment(
  appointmentId: string,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await softCancelTrialAppointmentInTx(tx, appointmentId);
  });
}

/**
 * The same retirement on the caller's transaction, so a caller that moves the
 * trial's status can commit the tombstone with it (#1846 SM-D2): split across
 * two transactions, a crash in between left a CANCELLED trial whose session
 * still occupied the consultant's calendar. Returns the sessions it released.
 */
export async function softCancelTrialAppointmentInTx(
  tx: Pick<
    Tx,
    | "appointmentOccurrence"
    | "appointment"
    | "appointmentParticipant"
    | "bookingStatusHistory"
  >,
  appointmentId: string,
): Promise<number> {
  const now = new Date();
  // Guarded like every other slot release: only live rows move, so a
  // concurrent capture/accept racing the cancel CASes instead of being
  // overwritten — and the move is audited. allowZero because the trial may
  // legitimately have no live rows left (already released, never placed).
  const released = await transitionOccurrenceCompletion(tx, {
    where: { appointmentId, deletedAt: null },
    to: OccurrenceCompletionStatus.CANCELLED,
    data: { deletedAt: now },
    allowZero: true,
  });
  await tx.appointment.updateMany({
    where: { id: appointmentId, deletedAt: null },
    data: { deletedAt: now },
  });
  // #1319 A9 — seat released with the tombstone.
  await transitionParticipant(tx, { appointmentId }, "CANCELLED");

  return released;
}

/**
 * Stamp `holdUntil` on any unstamped trial earnings once the trial refund has
 * settled (or when a 0% policy tier owes no refund), so retained earnings on
 * a late cancel do not stay parked with `holdUntil: null` forever while
 * ensuring a failed or pending refund never releases earnings prematurely.
 */
export async function stampTrialEarningsOnCancel(
  tx: {
    consultantEarnings?: Pick<
      Tx["consultantEarnings"],
      "findMany" | "findFirst" | "aggregate" | "updateMany"
    >;
    organizationEarnings?: Pick<Tx["organizationEarnings"], "updateMany">;
  },
  args: { paymentId?: string; appointmentId?: string | null; now?: Date },
): Promise<number> {
  const now = args.now ?? new Date();
  let whereScope:
    { paymentId: string } | { payment: { appointmentId: string } } | null =
    null;
  if (args.paymentId) {
    whereScope = { paymentId: args.paymentId };
  } else if (args.appointmentId) {
    whereScope = { payment: { appointmentId: args.appointmentId } };
  }
  if (!whereScope) return 0;
  const holdUntil = computeHoldUntil({
    capturedAt: now,
    lastOccurrenceEndsAt: null,
    holdHours: holdHoursFor("SUBSCRIPTION"),
  });
  const stamped = tx.consultantEarnings
    ? await stampConsultantHolds(
        { consultantEarnings: tx.consultantEarnings },
        {
          ...whereScope,
          holdUntil: null,
          status: { in: ["PENDING", "PENDING_TRUST"] },
        },
        holdUntil,
      )
    : 0;
  await tx.organizationEarnings?.updateMany?.({
    where: {
      ...whereScope,
      holdUntil: null,
      status: { in: ["PENDING", "PENDING_TRUST"] },
    },
    data: { holdUntil },
  });
  return stamped;
}

/**
 * A trial whose session is about to start, under way or already held is not
 * cancellable on any path; null when the cancel may proceed.
 */
export async function trialCancelWindowRefusal(
  appointmentId: string | null,
  db: PrismaLike = prisma,
): Promise<Refusal | null> {
  if (!appointmentId) return null;
  return cancelWindowRefusal(await readCancelWindowState(db, appointmentId), {
    appointmentId,
  });
}

/**
 * #1846 — what cancelling this paid trial right now pays back, computed and
 * never written. The trial cancel dialog shows it before the click, and trial
 * DELETE refunds only the amount the caller confirmed from it (a changed quote
 * answers 409 with the new one), so the number shown is the number charged.
 */
export interface TrialRefundQuote {
  paymentId: string;
  refundPct: number;
  estimatedRefundPaise: number;
  /** What was paid, for the dialog's breakdown line. */
  grossPaise: number;
  /** What is still refundable after any earlier partial refund. */
  refundablePaise: number;
  currency: string;
  fundingRail: FundingRail;
  /** Null when the trial has no session yet, which reads as full notice. */
  hoursUntilNextSession: number | null;
  prorated: false;
  /**
   * #1500 — this trial was funded entirely by referral credit, so the refund
   * IS the credit restoration and it is all-or-nothing. `estimatedRefundPaise`
   * reads 0 on this shape because no card was charged, so the dialog needs this
   * flag to say "your credits come back" instead of "you get nothing back".
   */
  creditRestoresInFull: boolean;
  /**
   * The policy tier's own percentage, unrounded up. `refundPct` is the effective
   * answer (100 on a credit restore), and the refund's audit reason quotes this
   * one, so the money trail never claims a tier the policy did not set.
   */
  tierRefundPct: number;
}

/**
 * The quote for a paid trial, or null when there is nothing to refund: a free
 * trial, an unpaid AWAITING_PAYMENT trial, or a payment that never captured.
 * Uses the same booking-time policy snapshot the appointment cancel applies.
 */
export async function quoteTrialRefund(
  args: {
    appointmentId: string | null;
    paymentId: string | null;
    isConsultantInitiated: boolean;
  },
  db: PrismaLike = prisma,
): Promise<TrialRefundQuote | null> {
  const { appointmentId, paymentId } = args;

  // Trial.paymentId is ledger truth once a paid trial settles, but the
  // webhook writes it after capture — fall back to the appointment's payment so
  // a cancellation racing that write still refunds.
  const payment = await db.payment.findFirst({
    where: {
      deletedAt: null,
      paymentStatus: PaymentStatus.SUCCEEDED,
      // #1161 — NO `amount: { gt: 0 }` here. That filter made a credit-funded
      // trial (a `free_` intent, `Payment.amount === 0`) unquotable, so the
      // cancel dialog read "nothing was paid for this" and `refundCancelledTrial`
      // returned before ever touching the credits rail: the referral credits the
      // buyer spent were consumed and never restored. The filter is exactly the
      // population whose value is NOT card money, which is the one population
      // `refundBookingPayment` settles most cheaply and most correctly.
      ...(paymentId
        ? { id: paymentId }
        : appointmentId
          ? { appointmentId }
          : { id: "__none__" }),
    },
    select: {
      id: true,
      amount: true,
      currency: true,
      paymentIntent: true,
      ...REFUNDABLE_BALANCE_SELECT,
    },
  });

  if (!payment) return null;

  const grossPaise = Number(payment.amount);
  const refundablePaise = refundableBalancePaise(grossPaise, payment);
  // Same notice, ladder and clamp as every other booking; a trial with no
  // appointment yet has no session at all, which reads as full notice.
  const ctx = appointmentId
    ? await resolveBookingRefundContext({ appointmentId }, undefined, db)
    : null;
  const quote = quoteBookingRefund({
    policy: ctx?.policy ?? null,
    hoursUntilNextSession: ctx?.hoursUntilNextSession ?? null,
    // No live session and none ever confirmed: the paid trial is still
    // waiting for its answer, so it has infinite notice. Once a session was
    // confirmed, its absence means held or settled, never full notice.
    slotsTotal:
      ctx?.hoursUntilNextSession === null
        ? ctx.confirmedSlotsTotal
        : (ctx?.slotsTotal ?? 0),
    sessionsRemaining: ctx?.sessionsRemaining ?? 0,
    sessionsRefunded: 0,
    isSubscription: false,
    isConsultantInitiated: args.isConsultantInitiated,
    // The rail alone is not enough: `free_` with a non-zero amount is a mixed
    // payment on the money arm.
    isFreeCreditFunded:
      fundingRailForIntent(payment.paymentIntent) === "CREDITS" &&
      grossPaise === 0,
    grossPaise,
    refundablePaise,
  });
  const creditRestoresInFull = quote.creditRestoresInFull;
  const estimatedRefundPaise = Math.max(0, quote.refundPaise);

  return {
    paymentId: payment.id,
    refundPct: quote.refundPct,
    estimatedRefundPaise,
    grossPaise,
    refundablePaise,
    currency: payment.currency,
    fundingRail: fundingRailForIntent(payment.paymentIntent),
    hoursUntilNextSession: Number.isFinite(quote.noticeHours)
      ? quote.noticeHours
      : null,
    prorated: false,
    creditRestoresInFull,
    tierRefundPct: quote.tierRefundPct,
  };
}

/**
 * #1846 — trial DELETE refunds only after the caller confirmed the quote. A
 * missing confirmation answers REFUND_QUOTE_REQUIRED and a stale one
 * REFUND_QUOTE_CHANGED, both with the current quote, so the client can show it
 * and ask again. Nothing has moved when this is thrown.
 */
export class TrialRefundQuoteError extends Error {
  readonly httpStatus = 409 as const;
  constructor(
    readonly code: "REFUND_QUOTE_REQUIRED" | "REFUND_QUOTE_CHANGED",
    readonly quote: TrialRefundQuote,
    paymentLanded = false,
  ) {
    super(
      code === "REFUND_QUOTE_REQUIRED"
        ? "Confirm the refund quote before cancelling this paid trial."
        : paymentLanded
          ? "Your payment just went through. Review the refund before you cancel."
          : "The refund for this trial has changed since you saw it. Check the new amount and confirm again.",
    );
    this.name = "TrialRefundQuoteError";
  }
}

/**
 * Throws unless the click confirmed the quote a paid trial has. A click made on
 * an unpaid screen never cancels a paid trial, even when both quotes are ₹0.
 */
export function assertTrialQuoteConfirmed(
  quote: TrialRefundQuote | null,
  click: TrialCancelBody,
): void {
  if (!quote) return;
  if (click.expectedPaid === false) {
    throw new TrialRefundQuoteError("REFUND_QUOTE_CHANGED", quote, true);
  }
  if (click.confirmedRefundPaise === undefined) {
    throw new TrialRefundQuoteError("REFUND_QUOTE_REQUIRED", quote);
  }
  if (click.expectedPaid === undefined) {
    console.info(
      "[trial-cancel] no expectedPaid on the click; paid state unbound",
    );
  }
  if (click.confirmedRefundPaise !== quote.estimatedRefundPaise) {
    throw new TrialRefundQuoteError("REFUND_QUOTE_CHANGED", quote);
  }
}

/**
 * The refund a cancelled trial owes under its quote, or null when
 * the quote pays nothing. The caller stamps it in the commit that ends the trial.
 */
export function trialRefundOwed(args: {
  trialId: string;
  quote: TrialRefundQuote | null;
  side: CancelSide;
}): RefundOwedMarker | null {
  const { quote, side } = args;
  if (!quote) return null;
  // The credits rail restores in full or not at all, so a credit
  // restore carries no amount; a 0% tier owes nothing on any rail.
  if (quote.creditRestoresInFull) {
    return {
      paymentId: quote.paymentId,
      amountPaise: null,
      key: `trial-cancel:${args.trialId}:${quote.paymentId}`,
      reason: trialCancelRefundReason(side, quote),
    };
  }
  if (quote.estimatedRefundPaise <= 0) return null;
  return {
    paymentId: quote.paymentId,
    amountPaise: quote.estimatedRefundPaise,
    key: `trial-cancel:${args.trialId}:${quote.paymentId}`,
    reason: trialCancelRefundReason(side, quote),
  };
}

/**
 * Settle a paid trial's cancellation after the commit that stamped `owed`:
 * drive the marker through the booking front door, then start the retained
 * earnings' hold once the money has settled.
 *
 * Never throws: a failed refund is reported and left on the marker for the
 * retry sweep, and surfaces to the caller as `failed`.
 */
export async function refundCancelledTrial(args: {
  trialId: string;
  initiatedByUserId: string;
  quote: TrialRefundQuote | null;
  owed: RefundOwedMarker | null;
}): Promise<TrialRefundOutcome | null> {
  const { trialId, quote, owed } = args;
  if (!quote) return null;
  const { refundPct } = quote;
  const stampHold = () =>
    stampTrialEarningsOnCancel(prisma, { paymentId: quote.paymentId });

  if (!owed) {
    await stampHold();
    return { refundPct, amountRefundedPaise: 0, rail: null };
  }

  const outcome = await driveRefundOwed(owed, {
    initiatedByUserId: args.initiatedByUserId,
  });
  if (outcome.kind === "refunded" || outcome.kind === "replayed") {
    if (outcome.refund.status !== "PENDING") await stampHold();
    return {
      refundPct,
      // A credit restore's Refund row is ₹0 by construction; `rail` says why.
      amountRefundedPaise: outcome.refund.amountRefundedPaise,
      rail: outcome.refund.rail ?? quote.fundingRail,
      ...(outcome.refund.status === "PENDING" ? { pending: true } : {}),
    };
  }
  if (outcome.kind === "settled") {
    await stampHold();
    return { refundPct, amountRefundedPaise: 0, rail: null };
  }
  if (outcome.kind === "failed") {
    Sentry.captureException(
      outcome.error instanceof Error
        ? outcome.error
        : new Error(String(outcome.error)),
      {
        tags: { subsystem: "trials" },
        extra: { trialId, paymentId: quote.paymentId },
      },
    );
  }
  // A live dispute (blocked) or a failed drive leaves the marker for the sweep.
  return { refundPct, amountRefundedPaise: 0, rail: null, failed: true };
}
