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

import prisma, { type PrismaLike, type Tx } from "@/lib/prisma";
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
 * Stamp `holdUntil` on any unstamped trial earnings once the trial refund has
 * settled (or when a 0% policy tier owes no refund), so retained earnings on
 * a late cancel do not stay parked with `holdUntil: null` forever while
 * ensuring a failed or pending refund never releases earnings prematurely.
 */
export async function stampTrialEarningsOnCancel(
  tx: {
    consultantEarnings?: Pick<Tx["consultantEarnings"], "updateMany">;
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
  const res = await tx.consultantEarnings?.updateMany?.({
    where: {
      ...whereScope,
      holdUntil: null,
      status: { in: ["PENDING", "PENDING_TRUST"] },
    },
    data: { holdUntil },
  });
  await tx.organizationEarnings?.updateMany?.({
    where: {
      ...whereScope,
      holdUntil: null,
      status: { in: ["PENDING", "PENDING_TRUST"] },
    },
    data: { holdUntil },
  });
  return res?.count ?? 0;
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

  const appointment = appointmentId
    ? await db.appointment.findUnique({
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
  // #1500 — a fully-credit-funded trial. The rail alone is not enough: a `free_`
  // intent with a non-zero amount is a mixed payment that settles on the money
  // arm, so both halves of the predicate are load-bearing. The credits rail
  // refuses a partial `amountPaise` outright, so a tier above 0% restores the
  // credit in full and a 0% tier restores nothing — a late cancel bites a credit
  // buyer exactly as it bites a card buyer.
  const isFreeCreditFunded =
    fundingRailForIntent(payment.paymentIntent) === "CREDITS" &&
    grossPaise === 0;
  const creditRestoresInFull = isFreeCreditFunded && refundPct > 0;
  // #1396 — `refundPct` may carry two decimals (a policy can say 12.5%), so
  // multiplying paise by the float first put a binary rounding error inside a
  // money amount before the floor ever ran. Scale to integer basis points and
  // divide once, exactly as `quoteBookingRefund` in cancellation-policy and
  // `refundRemovedAttendeeSeat` in event-refunds do; BigInt because the
  // intermediate product leaves the safe-integer range long before the amounts
  // stop being real money. BigInt division truncates toward zero and both
  // operands are non-negative, so this floors — the same rounding direction as
  // every other rail, which is what keeps a quote and a charge from disagreeing.
  const policyRefundPaise = Number(
    (BigInt(grossPaise) * BigInt(Math.round(refundPct * 100))) / BigInt(10_000),
  );
  // Clamp to the remaining balance, as the cancel and seat-refund paths do. A
  // percentage of the gross overshoots a payment that has already given some
  // back, `refundPayment` rejects the whole request, and the catch below turns
  // that into "refunded 0" — the buyer loses the remainder they were owed.
  const estimatedRefundPaise = Math.max(
    0,
    Math.min(policyRefundPaise, refundablePaise),
  );

  return {
    paymentId: payment.id,
    refundPct: creditRestoresInFull ? 100 : refundPct,
    estimatedRefundPaise,
    grossPaise,
    refundablePaise,
    currency: payment.currency,
    fundingRail: fundingRailForIntent(payment.paymentIntent),
    hoursUntilNextSession: Number.isFinite(hoursUntilStart)
      ? hoursUntilStart
      : null,
    prorated: false,
    creditRestoresInFull,
    tierRefundPct: refundPct,
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
 * The refund a cancelled or declined trial owes under its quote, or null when
 * the quote pays nothing. The caller stamps it in the commit that ends the trial.
 */
export function trialRefundOwed(args: {
  trialId: string;
  quote: TrialRefundQuote | null;
  isConsultantInitiated: boolean;
}): RefundOwedMarker | null {
  const { quote } = args;
  if (!quote) return null;
  const side = args.isConsultantInitiated ? "consultant" : "consultee";
  // The credits rail restores in full or not at all, so a credit
  // restore carries no amount; a 0% tier owes nothing on any rail.
  if (quote.creditRestoresInFull) {
    return {
      paymentId: quote.paymentId,
      amountPaise: null,
      key: `trial-cancel:${args.trialId}:${quote.paymentId}`,
      reason: `trial cancellation (credit-funded trial, credit restored in full from the ${quote.tierRefundPct}% tier, ${side}-initiated)`,
    };
  }
  if (quote.estimatedRefundPaise <= 0) return null;
  return {
    paymentId: quote.paymentId,
    amountPaise: quote.estimatedRefundPaise,
    key: `trial-cancel:${args.trialId}:${quote.paymentId}`,
    reason: `trial cancellation (${quote.tierRefundPct}% per booking-time policy, ${side}-initiated)`,
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
