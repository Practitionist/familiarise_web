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

import * as Sentry from "@sentry/nextjs";
import { transitionParticipant } from "@/lib/booking/participants";
import { transitionOccurrenceCompletion } from "@/lib/booking/transitions";
import { PaymentStatus, OccurrenceCompletionStatus } from "@prisma/client";

import prisma, { type Tx } from "@/lib/prisma";
import {
  REFUNDABLE_BALANCE_SELECT,
  refundableBalancePaise,
} from "@/lib/payments/refundable-balance";
import { computeRefundPct } from "@/lib/payments/operations/cancellation-policy";
import {
  POLICY_TERMS_INCLUDE,
  termsFromPolicyRow,
} from "@/lib/payments/operations/cancellation-policy-store";
import {
  fundingRailForIntent,
  refundBookingPayment,
  type FundingRail,
} from "@/lib/payments/operations/booking-refund";

export type TrialRefundOutcome = {
  refundPct: number;
  amountRefundedPaise: number;
  /** Set when the gateway leg failed; the cancellation still stands. */
  failed?: boolean;
};

/**
 * Retire the appointment behind a cancelled or rejected trial.
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
}

/**
 * The quote for a paid trial, or null when there is nothing to refund: a free
 * trial, an unpaid AWAITING_PAYMENT trial, or a payment that never captured.
 * Uses the same booking-time policy snapshot the appointment cancel applies.
 */
export async function quoteTrialRefund(args: {
  appointmentId: string | null;
  paymentId: string | null;
  isConsultantInitiated: boolean;
}): Promise<TrialRefundQuote | null> {
  const { appointmentId, paymentId } = args;

  // Trial.paymentId is ledger truth once a paid trial settles, but the
  // webhook writes it after capture — fall back to the appointment's payment so
  // a cancellation racing that write still refunds.
  const payment = await prisma.payment.findFirst({
    where: {
      deletedAt: null,
      paymentStatus: PaymentStatus.SUCCEEDED,
      amount: { gt: 0 },
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

  const appointment = appointmentId
    ? await prisma.appointment.findUnique({
        where: { id: appointmentId },
        select: {
          cancellationPolicy: POLICY_TERMS_INCLUDE,
          occurrences: {
            orderBy: { startsAt: "asc" },
            take: 1,
            select: { startsAt: true },
          },
        },
      })
    : null;

  // #1775 C-11 — no session yet (a paid trial waiting for its answer) is
  // infinite notice, as quoteBookingRefund reads it; -1 refunded 0 %.
  const startsAt = appointment?.occurrences[0]?.startsAt;
  const hoursUntilStart = startsAt
    ? (startsAt.getTime() - Date.now()) / 3_600_000
    : Number.POSITIVE_INFINITY;

  const refundPct = computeRefundPct(
    termsFromPolicyRow(appointment?.cancellationPolicy),
    hoursUntilStart,
    args.isConsultantInitiated,
  );
  const grossPaise = Number(payment.amount);
  const refundablePaise = refundableBalancePaise(grossPaise, payment);
  // Clamp to the remaining balance, as the cancel and seat-refund paths do. A
  // percentage of the gross overshoots a payment that has already given some
  // back, `refundPayment` rejects the whole request, and the catch below turns
  // that into "refunded 0" — the buyer loses the remainder they were owed.
  const estimatedRefundPaise = Math.max(
    0,
    Math.min(Math.floor((grossPaise * refundPct) / 100), refundablePaise),
  );

  return {
    paymentId: payment.id,
    refundPct,
    estimatedRefundPaise,
    grossPaise,
    refundablePaise,
    currency: payment.currency,
    fundingRail: fundingRailForIntent(payment.paymentIntent),
    hoursUntilNextSession: Number.isFinite(hoursUntilStart)
      ? hoursUntilStart
      : null,
    prorated: false,
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
  ) {
    super(
      code === "REFUND_QUOTE_REQUIRED"
        ? "Confirm the refund quote before cancelling this paid trial."
        : "The refund for this trial has changed since you saw it. Check the new amount and confirm again.",
    );
    this.name = "TrialRefundQuoteError";
  }
}

/** Throws unless `confirmedRefundPaise` matches the quote a paid trial has. */
export function assertTrialQuoteConfirmed(
  quote: TrialRefundQuote | null,
  confirmedRefundPaise: number | undefined,
): void {
  if (!quote) return;
  if (confirmedRefundPaise === undefined) {
    throw new TrialRefundQuoteError("REFUND_QUOTE_REQUIRED", quote);
  }
  if (confirmedRefundPaise !== quote.estimatedRefundPaise) {
    throw new TrialRefundQuoteError("REFUND_QUOTE_CHANGED", quote);
  }
}

/**
 * Refund a paid trial on cancellation. A caller that already quoted (trial
 * DELETE, after the confirmation check) passes that quote so the charge is the
 * confirmed number; everyone else gets a fresh quote.
 *
 * Returns null when there is nothing to refund.
 *
 * Deliberately never throws: the cancellation has already committed by the time
 * this runs, and a gateway failure must not roll it back. A failed refund is
 * reported to Sentry and surfaced to the caller as `failed`, matching how
 * `app/api/appointments/[appointmentId]/cancel/route.ts` handles the same case.
 */
export async function refundCancelledTrial(args: {
  trialId: string;
  appointmentId: string | null;
  paymentId: string | null;
  initiatedByUserId: string;
  isConsultantInitiated: boolean;
  quote?: TrialRefundQuote | null;
}): Promise<TrialRefundOutcome | null> {
  const { trialId, initiatedByUserId } = args;
  const quote =
    args.quote === undefined ? await quoteTrialRefund(args) : args.quote;
  if (!quote) return null;

  const { refundPct, estimatedRefundPaise: amountPaise } = quote;
  if (amountPaise <= 0) return { refundPct, amountRefundedPaise: 0 };

  try {
    // Audit B-P1-07 — route through the booking front door so org-funded and
    // free_ trials hit the correct rail (in-ledger reversal / credit restore)
    // instead of throwing UNKNOWN_GATEWAY on the raw gateway path.
    const result = await refundBookingPayment({
      paymentId: quote.paymentId,
      amountPaise,
      reason: `trial cancellation (${refundPct}% per booking-time policy, ${
        args.isConsultantInitiated ? "consultant" : "consultee"
      }-initiated)`,
      initiatedByUserId,
    });
    return {
      refundPct,
      amountRefundedPaise: result.amountRefundedPaise,
    };
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      {
        tags: { subsystem: "trials" },
        extra: { trialId, paymentId: quote.paymentId },
      },
    );
    console.error(
      `[Trials] refund failed for payment ${quote.paymentId}:`,
      error,
    );
    return { refundPct, amountRefundedPaise: 0, failed: true };
  }
}
