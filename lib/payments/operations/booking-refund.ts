/**
 * Refund ONE booking payment, whatever rail funded it (#1003, #1020).
 *
 * `refundPayment` calls the gateway unconditionally, and an org-funded booking
 * carries a synthetic `org_wallet_` / `org_license_` / `org_invoice_`
 * paymentIntent that no gateway can resolve. So every org-funded 1:1
 * cancellation died on UNKNOWN_GATEWAY in Phase 2 — before the cascade ran —
 * and the caller swallowed it as "refunded 0". Nothing was reversed: the org
 * wallet was never credited back, the invoice accrual never netted down, the
 * program engagement never returned to the cap, the consultant's earnings
 * stayed payable and no ledger entry was written.
 *
 * `refundWholeEventPayments` already splits the two rails for class/webinar
 * seats. 1:1 bookings had no equivalent; this is that split.
 *
 *   - GATEWAY / MOCK — real card money, must credit the card, so it keeps
 *     going through `refundPayment` (which owns the two-phase gateway
 *     discipline and its own overage credit-back).
 *   - INTERNAL org-funded — no card was ever charged; the money lives in the
 *     wallet / invoice accrual / license ledger, so it reverses purely
 *     in-ledger through the reversal engine's BOOKING source.
 *
 * #1161 — this IS the universal front door now. The third rail, a booking
 * fully covered by referral credits (`free_` intent, `Payment.amount === 0`),
 * settles here: no gateway leg, and no card money to move — but not nothing.
 * The booking-time posting debited PLATFORM_PROMO for the credit funding and
 * credited the consultant/org payables, GST and the platform fee, and
 * ConsultantEarnings accrued on the gross, so cancellation mirrors that
 * journal in-ledger (payables debited, earnings netted, PLATFORM_PROMO back
 * to credit), reverses BookingUtilization (a defensive no-op for personal
 * bookings — credits are refused on org-funded checkouts), and restores the
 * credits in full. Callers must stop filtering on `amount > 0` and send every
 * SUCCEEDED payment through.
 */

import {
  noticeReason,
  refundNoticeKind,
  refundNoticeOverride,
} from "./refund-cause";
import { Prisma, PaymentStatus, RefundStatus } from "@prisma/client";
import { transitionParticipant } from "@/lib/booking/participants";
import {
  REFUNDABLE_BALANCE_SELECT,
  refundableBalancePaise,
} from "@/lib/payments/refundable-balance";

/**
 * After a gateway refund commits: whether any of the payment is still refundable, by the rail's
 * own balance maths. The last of two concurrent partials reads both rows, so together they end
 * the seat. An unreadable balance keeps the seat and never fails the committed refund.
 */
async function leavesRefundable(paymentId: string): Promise<boolean> {
  try {
    const payment = await prisma.payment.findUnique({
      where: { id: paymentId },
      select: { amount: true, ...REFUNDABLE_BALANCE_SELECT },
    });
    if (!payment) return false;
    return refundableBalancePaise(payment.amount, payment) > 0;
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "refund_balance_read_failed",
        paymentId,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return true;
  }
}

/** A refund with no amount returns the whole balance and ends the seat; only an explicit amount reads what is left. */
async function keepsSeat(input: {
  paymentId: string;
  amountPaise?: number;
  keepSeat?: boolean;
  keepSeatIfPartial?: boolean;
}): Promise<boolean> {
  if (input.keepSeat) return true;
  if (!input.keepSeatIfPartial || input.amountPaise === undefined) return false;
  return leavesRefundable(input.paymentId);
}

/** An event learner seat the refund ends gets a `refunded` row; a 1:1 seat gets none. */
const refundedSeat = (actorUserId: string | null | undefined) => ({
  history: { reason: "refunded" as const, actorUserId: actorUserId ?? null },
});

async function markParticipantsRefunded(
  paymentId: string,
  actorUserId?: string | null,
): Promise<void> {
  try {
    await transitionParticipant(
      prisma,
      { paymentId },
      "REFUNDED",
      refundedSeat(actorUserId),
    );
  } catch (error) {
    // Shadow table: never let it fail a refund that already went through.
    console.warn(
      JSON.stringify({
        event: "participant_refund_stamp_failed",
        paymentId,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}

import prisma, { type Tx } from "@/lib/prisma";
import { withSerializableRetry } from "@/lib/db/serializable-retry";
import {
  restoreCreditsForPaymentUpTo,
  reverseCreditsForPayment,
} from "@/lib/referrals/service";
import { seatLedger } from "@/lib/booking/class-series";
import { sessionsTotalOf } from "@/lib/booking/entitlement";
import { reverseBookingUtilization } from "@/lib/api/organizations/program-helpers";
import { stampTranchesOnCancel } from "@/lib/booking/subscription-cycle";
import { recordTdsReversal } from "@/lib/payments/tax/tds-service";
import { postLedgerTxn, type Posting } from "@/lib/payments/ledger/post";
import { refundReversalBasis } from "@/lib/payments/ledger/refund-reversal-basis";
import { mintConsumerCreditNote } from "@/lib/payments/billing/consumer-invoice";
import { isPastGstCreditNoteCutoff } from "@/lib/compliance/gst-credit-note-cutoff";
import {
  attemptTrigger,
  notifyRefundProcessed,
  type StagedTrigger,
} from "@/lib/novu";
import { notificationScope } from "@/lib/novu/workflows";
import { getAppUrl } from "@/lib/url";
import { goHref } from "@/lib/dashboard/go";
import {
  EMAIL_BUDGET_MS,
  MONEY_EMAIL_TYPES,
  prepareRefundProcessedEmail,
  stageRefundProcessedEmail,
} from "@/lib/email";
import {
  attemptStaged as attemptStagedEmails,
  type StagedRecipientEmail,
} from "@/lib/email/send-to-recipients";
import type { PreparedSpecEmails } from "@/lib/email/senders/shared";
import { applyReversal, clawBackCompletedOrgPayout } from "./reversal-engine";
import {
  accumulatePaidConsultantClawback,
  applyPaidConsultantClawbacks,
  type PendingConsultantClawback,
} from "@/lib/payments/payouts/paid-consultant-clawback";
import {
  findDedupedRefund,
  isDedupeKeyConflict,
  RefundValidationError,
  refundPayment,
} from "./refund";
// Late-bound cycle: refund-owed drives its markers through this module.
import {
  claimOwedMarker,
  refuseIfOwedAlreadySent,
  settleOwedByHand,
  type HandSettledOwed,
  type OwedMarkerInput,
} from "./refund-owed";

import {
  applyCappedEarningReversal,
  applyCappedOrgEarningReversal,
} from "@/lib/payments/payouts/earning-reversal-cas";
import {
  type FundingRail,
  isFreeCreditIntent,
  isInternalFundedIntent,
} from "@/lib/payments/funding-rail";

/**
 * #1589 N-P0-01 — the payer's notice for a refund that never touches the
 * gateway. Gateway refunds are told by the `refund.processed` webhook; the
 * INTERNAL and CREDITS rails settle in one transaction and told nobody. The
 * bell and the receipt are staged inside that transaction (same rows the
 * webhook stages) and attempted after commit; the outbox's deterministic
 * `transactionId` (lib/novu/outbox.ts) is what makes a re-drive safe.
 */
type StagedRefundNotice = {
  bell: StagedTrigger | null;
  emails: StagedRecipientEmail[];
};

function refundReceiptArgs(
  payment: { id: string; userId: string; currency: string },
  amountPaise: number,
  reason: string | null | undefined,
) {
  return {
    userId: payment.userId,
    paymentId: payment.id,
    amountPaise,
    currency: payment.currency,
    required: refundNoticeKind(reason) !== null,
  };
}

async function stageRefundNotice(
  tx: Tx,
  payment: {
    id: string;
    userId: string;
    organizationId: string | null;
    currency: string;
  },
  amountPaise: number,
  reason: string | null | undefined,
  receipt?: PreparedSpecEmails | null,
): Promise<StagedRefundNotice> {
  const bell = await notifyRefundProcessed(
    payment.userId,
    {
      ...notificationScope(payment.organizationId),
      amount: amountPaise,
      currency: payment.currency,
      // #1527 — the recipient is always the payer.
      dashboardUrl: `${getAppUrl()}${goHref("client", "payments")}`,
    },
    {
      tx,
      entityRef: `payment:${payment.id}`,
      required: refundNoticeOverride(reason, payment.userId),
    },
  );
  const emails = await stageRefundProcessedEmail(
    tx,
    refundReceiptArgs(payment, amountPaise, reason),
    receipt,
  );
  return { bell: bell?.staged ?? null, emails };
}

/** Post-commit half: never inside the Serializable callback. */
async function attemptRefundNotice(
  staged: StagedRefundNotice | null,
): Promise<void> {
  if (!staged) return;
  await Promise.allSettled([
    ...(staged.bell ? [attemptTrigger(staged.bell)] : []),
    attemptStagedEmails(
      staged.emails,
      MONEY_EMAIL_TYPES.REFUND_PROCESSED,
      EMAIL_BUDGET_MS.REQUEST,
    ),
  ]);
}

export type BookingRefundResult = {
  refundId: string;
  amountRefundedPaise: number;
  /** Which rail actually returned the money (CREDITS = referral restoration). */
  rail: FundingRail;
  /** Present when the gateway returned a settlement status ("SUCCEEDED" | "PENDING"). */
  status?: "SUCCEEDED" | "PENDING";
  /** The owed refund this hand refund settled and cleared. */
  settledOwed?: HandSettledOwed;
};

export async function refundBookingPayment(
  input: Parameters<typeof refundBookingPaymentOnRail>[0],
): Promise<BookingRefundResult> {
  const outcome = await refundBookingPaymentOnRail(input);
  if (!outcome.endsSeat) return outcome.result;
  // After commit: the refunded seat loses the chat and call access the join gate no longer grants.
  const { persistRefundRevocation, revokeRefundedSeatAccess } =
    await import("@/lib/stream/access-revocation");
  const intent = {
    refundId: outcome.result.refundId,
    payerUserId: outcome.payerUserId,
  };
  if (outcome.result.rail === "GATEWAY") {
    // The intent lands first, so a failed stamp is re-stamped by the sweep.
    await persistRefundRevocation(intent);
    await markParticipantsRefunded(input.paymentId, input.initiatedByUserId);
  }
  await revokeRefundedSeatAccess(intent, outcome.intentGeneration);
  return outcome.result;
}

/**
 * Re-applies a seat-ending refund's REFUNDED stamp, only while the refund stands
 * as SUCCEEDED or PENDING; a FAILED or CANCELLED refund moved no money, so its seat stays live.
 */
export async function restampRefundedSeats(
  refundId: string,
): Promise<"stamped" | "skipped"> {
  const refund = await prisma.refund.findUnique({
    where: { id: refundId },
    select: { status: true, paymentId: true },
  });
  if (
    !refund ||
    (refund.status !== RefundStatus.SUCCEEDED &&
      refund.status !== RefundStatus.PENDING)
  ) {
    return "skipped";
  }
  await transitionParticipant(
    prisma,
    { paymentId: refund.paymentId },
    "REFUNDED",
    refundedSeat(null),
  );
  return "stamped";
}

/** The rail's result plus what the post-commit revocation needs. */
type RailOutcome = {
  result: BookingRefundResult;
  payerUserId: string;
  /** The rail's own decision that this refund ends the funded seat. */
  endsSeat: boolean;
  /** The revocation intent the refund's transaction wrote, or null when none was. */
  intentGeneration: Date | null;
};

async function refundBookingPaymentOnRail(
  input: {
    paymentId: string;
    /** Defaults to the full remaining refundable balance. */
    amountPaise?: number;
    reason: string;
    initiatedByUserId?: string | null;
    /** #1780 — one refund per key on every rail; a repeat returns the first. */
    dedupeKey?: string;
    supportRecommendationId?: string;
    /**
     * #1780 row 4 — a per-session refund (a missed class session) leaves the
     * seat live; every other refund marks the funded seat REFUNDED.
     */
    keepSeat?: boolean;
    /** An explicit amount keeps the seat live only while part of the payment stays refundable; no amount ends it. */
    keepSeatIfPartial?: boolean;
  } & OwedMarkerInput,
): Promise<RailOutcome> {
  // #781 §B — soft-deleted financial rows are retired; never refund them.
  const payment = await prisma.payment.findUnique({
    where: { id: input.paymentId, deletedAt: null },
    select: { paymentIntent: true, refundOwedKey: true, userId: true },
  });
  if (!payment) {
    throw new RefundValidationError(
      `Payment ${input.paymentId} not found`,
      "PAYMENT_NOT_FOUND",
    );
  }
  if (input.settlesOwedByHand)
    await refuseIfOwedAlreadySent(input.paymentId, payment.refundOwedKey);
  const payerUserId = payment.userId;

  if (isFreeCreditIntent(payment.paymentIntent)) {
    // The credits rail restores in full or not at all — honouring a partial
    // amount would silently over-restore, then block the remainder forever
    // behind its own ALREADY_FULLY_REFUNDED claim (#1161).
    if (input.amountPaise !== undefined) {
      throw new RefundValidationError(
        `Payment ${input.paymentId} is credit-funded; the credits rail accepts no amount`,
        "INVALID_AMOUNT",
      );
    }
    // The credits rail always stamps the seat REFUNDED in its transaction.
    let generation = null as Date | null;
    const result = await withDedupe(input, "CREDITS", async () => {
      const credits = await refundFreeCreditPayment(input);
      generation = credits.intentGeneration;
      return credits.result;
    });
    return {
      result,
      payerUserId,
      endsSeat: true,
      intentGeneration: generation,
    };
  }

  if (!isInternalFundedIntent(payment.paymentIntent)) {
    const r = await refundPayment(input);
    // The seat is stamped REFUNDED after the gateway refund committed, by the caller.
    const endsSeat = !(await keepsSeat(input));
    return {
      result: {
        refundId: r.refundId,
        amountRefundedPaise: r.amountRefundedPaise,
        rail: "GATEWAY",
        ...(r.status ? { status: r.status } : {}),
        ...(r.settledOwed ? { settledOwed: r.settledOwed } : {}),
      },
      payerUserId,
      endsSeat,
      intentGeneration: null,
    };
  }

  let decided = null as {
    endsSeat: boolean;
    intentGeneration: Date | null;
  } | null;
  const result = await withDedupe(input, "INTERNAL", async () => {
    const internal = await refundInternalFundedPayment(input);
    decided = internal;
    return internal.result;
  });
  // A key already spent answers without the transaction, so the seat is decided as on the gateway rail.
  const endsSeat = decided?.endsSeat ?? !(await keepsSeat(input));
  return {
    result,
    payerUserId,
    endsSeat,
    intentGeneration: decided?.intentGeneration ?? null,
  };
}

/**
 * #1780 — the in-ledger rails honour the same key as the gateway rail: a key
 * already spent answers with its refund, and a lost unique race is that answer.
 */
async function withDedupe(
  input: { dedupeKey?: string },
  rail: FundingRail,
  run: () => Promise<BookingRefundResult>,
): Promise<BookingRefundResult> {
  if (!input.dedupeKey) return run();
  const answered = async () => {
    const prior = await findDedupedRefund(input.dedupeKey);
    return prior
      ? {
          refundId: prior.refundId,
          amountRefundedPaise: prior.amountRefundedPaise,
          rail,
          ...(prior.status ? { status: prior.status } : {}),
        }
      : null;
  };
  const prior = await answered();
  if (prior) return prior;
  try {
    return await run();
  } catch (err) {
    const winner = isDedupeKeyConflict(err) ? await answered() : null;
    if (winner) return winner;
    throw err;
  }
}

/**
 * #1161 — restore the referral credits behind a fully-credit-funded booking.
 *
 * There is no card money to move: `Payment.amount` is 0 and the value lives in
 * the consumed `ReferralCreditUsage` rows. But the booking was not free — the
 * booking-time posting debited PLATFORM_PROMO and credited the payables, and
 * ConsultantEarnings accrued on the gross. So alongside the credit restoration
 * this runs the same in-ledger reversal the org rail gets, minus the gateway
 * phases. A zero-amount Refund row is minted so the cancellation leaves the
 * same audit shape as every other rail, and its existence doubles as the
 * idempotency claim — a second cancellation of the same booking restores
 * nothing twice.
 */
async function refundFreeCreditPayment(
  input: {
    paymentId: string;
    reason: string;
    initiatedByUserId?: string | null;
    dedupeKey?: string;
    supportRecommendationId?: string;
  } & OwedMarkerInput,
): Promise<{ result: BookingRefundResult; intentGeneration: Date }> {
  const payment = await prisma.payment.findUnique({
    where: { id: input.paymentId, deletedAt: null },
    select: {
      id: true,
      userId: true,
      organizationId: true,
      currency: true,
      paymentStatus: true,
      paymentGateway: true,
    },
  });
  if (!payment) {
    throw new RefundValidationError(
      `Payment ${input.paymentId} not found`,
      "PAYMENT_NOT_FOUND",
    );
  }
  if (payment.paymentStatus !== PaymentStatus.SUCCEEDED) {
    throw new RefundValidationError(
      `Payment ${input.paymentId} is not SUCCEEDED (status=${payment.paymentStatus}); cannot refund`,
      "PAYMENT_NOT_SUCCEEDED",
    );
  }

  // Loaded before the transaction, so no module load runs while it holds the connection.
  const { persistRefundRevocationInTx } =
    await import("@/lib/stream/access-revocation");
  // Staged inside the tx, attempted after it; a retried attempt re-stages.
  let notice: StagedRefundNotice | null = null;
  const result = await withSerializableRetry(() =>
    prisma.$transaction(
      async (tx) => {
        const existing = await tx.refund.findFirst({
          where: {
            paymentId: payment.id,
            status: { in: [RefundStatus.SUCCEEDED, RefundStatus.PENDING] },
          },
          select: { id: true },
        });
        if (existing) {
          throw new RefundValidationError(
            `Payment ${payment.id} already has its credit restoration`,
            "ALREADY_FULLY_REFUNDED",
          );
        }
        const settledOwed = await claimOwedMarker(tx, payment.id, input, {
          kind: "whole",
        });

        const refundRow = await tx.refund.create({
          data: {
            paymentId: payment.id,
            amountPaise: 0,
            currency: payment.currency,
            reason: input.reason,
            status: RefundStatus.SUCCEEDED,
            refundId: `credits_${globalThis.crypto.randomUUID()}`,
            dedupeKey: input.dedupeKey ?? null,
            ...(input.supportRecommendationId
              ? {
                  supportRecommendation: {
                    connect: { id: input.supportRecommendationId },
                  },
                }
              : {}),
            paymentGateway: payment.paymentGateway,
            metadata: {
              initiatedByUserId: input.initiatedByUserId ?? null,
              source: "free-credit",
              ...(settledOwed ? { settledOwed } : {}),
            } as Prisma.InputJsonValue,
          },
        });

        // No amounts → full restoration of every usage row on the payment.
        const restoredPaise = await reverseCreditsForPayment(
          payment.id,
          tx,
          undefined,
          undefined,
          refundRow.id,
        );

        // #1003 convention (mirrors cancelPendingCheckout): utilization is
        // debited at checkout before capture, so release it here. A no-op for
        // personal bookings, which have no utilization row — referral credits
        // are refused on org-funded checkouts, so a free_ payment can only be
        // personal.
        await reverseBookingUtilization(tx, {
          paymentId: payment.id,
          reason: input.reason,
        });

        // Mirror the booking-time PLATFORM_PROMO journal: net the payables'
        // source rows and counter-post the funding. Same tx as the Refund row,
        // so a failed posting rolls the whole restoration back atomically.
        await reverseFreeCreditSettlement(tx, {
          paymentId: payment.id,
          refundId: refundRow.id,
          initiatedByUserId: input.initiatedByUserId ?? null,
          reason: input.reason,
        });

        await transitionParticipant(
          tx,
          { paymentId: payment.id },
          "REFUNDED",
          refundedSeat(input.initiatedByUserId),
        );
        const intentGeneration = await persistRefundRevocationInTx(tx, {
          refundId: refundRow.id,
          payerUserId: payment.userId,
        });
        // The Refund row is ₹0; the value that came back is the restored credit.
        notice = await stageRefundNotice(
          tx,
          payment,
          restoredPaise,
          noticeReason(settledOwed, input.reason),
        );
        return {
          result: {
            refundId: refundRow.id,
            amountRefundedPaise: 0,
            rail: "CREDITS" as const,
            ...(settledOwed ? { settledOwed } : {}),
          },
          intentGeneration,
        };
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        maxWait: 10_000,
        timeout: 15_000,
      },
    ),
  );
  await attemptRefundNotice(notice);
  return result;
}

/**
 * #1771 K-5 — return N sessions of a credit-funded class seat or subscription.
 * The credits rail restores whole or not at all, so an ops partial return is
 * its own door: N × the booking's credit unit (capped at what is still
 * consumed), a ₹0 Refund row under the caller's key, and the booking journal
 * reversed pro rata, so delivered sessions keep their earnings. A later whole
 * restoration is refused (the row exists); further returns come back here.
 */
export async function restoreSessionCredits(input: {
  paymentId: string;
  sessions: number;
  reason: string;
  initiatedByUserId: string | null;
  dedupeKey: string;
}): Promise<BookingRefundResult & { restoredPaise: number }> {
  if (!Number.isInteger(input.sessions) || input.sessions < 1) {
    throw new RefundValidationError(
      "Return at least one whole session",
      "INVALID_AMOUNT",
    );
  }
  const payment = await prisma.payment.findUnique({
    where: { id: input.paymentId, deletedAt: null },
    select: {
      id: true,
      userId: true,
      organizationId: true,
      currency: true,
      paymentStatus: true,
      paymentGateway: true,
      paymentIntent: true,
      createdAt: true,
      appointmentId: true,
      appointment: { select: { classId: true, subscriptionId: true } },
      refundOwedKey: true,
    },
  });
  if (
    !payment?.appointmentId ||
    (!payment.appointment?.classId && !payment.appointment?.subscriptionId)
  ) {
    throw new RefundValidationError(
      "This payment is not for a class seat or a subscription, so it has no session credits to restore.",
      "NOT_SESSION_CREDIT",
      { paymentId: input.paymentId },
    );
  }
  const isSubscription = !payment.appointment.classId;
  await refuseIfOwedAlreadySent(payment.id, payment.refundOwedKey);
  if (!isFreeCreditIntent(payment.paymentIntent)) {
    throw new RefundValidationError(
      "This payment was not made with credits. Refund an amount instead.",
      "NOT_CREDIT_FUNDED",
      { paymentId: input.paymentId },
    );
  }
  if (payment.paymentStatus !== PaymentStatus.SUCCEEDED) {
    throw new RefundValidationError(
      "This payment was never completed, so there is nothing to restore.",
      "PAYMENT_NOT_SUCCEEDED",
      { paymentId: input.paymentId, paymentStatus: payment.paymentStatus },
    );
  }
  const appointmentId = payment.appointmentId;
  let restoredPaise = 0;
  let notice: StagedRefundNotice | null = null;
  let createdRefundId = null as string | null;
  const result = await withDedupe(input, "CREDITS", () =>
    withSerializableRetry(() =>
      prisma.$transaction(
        async (tx) => {
          // A retried attempt starts clean: nothing of a rolled-back one survives.
          restoredPaise = 0;
          notice = null;
          createdRefundId = null;
          const usages = await tx.referralCreditUsage.findMany({
            where: { paymentId: payment.id },
            select: { amount: true, originalAmount: true },
          });
          const creditValue = usages.reduce((s, u) => s + u.originalAmount, 0);
          const stillUsed = usages.reduce((s, u) => s + u.amount, 0);
          if (creditValue <= 0 || stillUsed <= 0) {
            throw new RefundValidationError(
              `Payment ${payment.id} has no credit left to return`,
              "ALREADY_FULLY_REFUNDED",
            );
          }
          const { ledger, eligible, seatLive } = isSubscription
            ? await subscriptionCreditBounds(tx, appointmentId, creditValue)
            : await classSeatCreditBounds(
                tx,
                payment,
                appointmentId,
                creditValue,
              );
          assertReturnable(payment.id, ledger, input.sessions, {
            creditValue,
            stillUsed,
            eligible,
            seatLive,
          });
          const asked = Number(ledger.unitPaise) * input.sessions;
          const refundRow = await tx.refund.create({
            data: {
              paymentId: payment.id,
              amountPaise: 0,
              currency: payment.currency,
              reason: input.reason,
              status: RefundStatus.SUCCEEDED,
              refundId: `credits_${globalThis.crypto.randomUUID()}`,
              dedupeKey: input.dedupeKey,
              paymentGateway: payment.paymentGateway,
              metadata: {
                initiatedByUserId: input.initiatedByUserId,
                source: "free-credit-partial",
                sessions: input.sessions,
              } as Prisma.InputJsonValue,
            },
          });
          restoredPaise = await restoreCreditsForPaymentUpTo(
            payment.id,
            tx,
            Math.min(asked, stillUsed),
            refundRow.id,
          );
          if (restoredPaise <= 0) {
            throw new RefundValidationError(
              `The credit behind payment ${payment.id} has expired`,
              "CREDIT_EXPIRED",
            );
          }
          // Only operators return session credits, so this settles the owed refund by hand.
          const settledOwed = await settleOwedByHand(tx, payment.id, {
            kind: restoredPaise >= stillUsed ? "whole" : "credits-part",
          });
          // Kept on the row, so a keyed replay answers the real amount.
          await tx.refund.update({
            where: { id: refundRow.id },
            data: {
              metadata: {
                initiatedByUserId: input.initiatedByUserId,
                source: "free-credit-partial",
                sessions: input.sessions,
                restoredPaise,
                ...(settledOwed ? { settledOwed } : {}),
              } as Prisma.InputJsonValue,
            },
          });
          createdRefundId = refundRow.id;
          await reverseFreeCreditSettlement(tx, {
            paymentId: payment.id,
            refundId: refundRow.id,
            initiatedByUserId: input.initiatedByUserId,
            reason: input.reason,
            share: { num: restoredPaise, den: creditValue },
            completes: restoredPaise >= stillUsed,
          });
          // An ended plan's tranches waited unheld for this return; what the
          // reversal left of them starts its hold in the same commit.
          if (isSubscription && !seatLive) {
            await stampTranchesOnCancel(tx, {
              paymentId: payment.id,
              now: new Date(),
            });
          }
          notice = await stageRefundNotice(
            tx,
            payment,
            restoredPaise,
            noticeReason(settledOwed, input.reason),
          );
          return {
            refundId: refundRow.id,
            amountRefundedPaise: 0,
            rail: "CREDITS" as const,
            ...(settledOwed ? { settledOwed } : {}),
          };
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          maxWait: 10_000,
          timeout: 15_000,
        },
      ),
    ),
  );
  if (result.refundId !== createdRefundId) {
    // A replay (or a lost key race): the first attempt's row is the answer.
    return { ...result, restoredPaise: await restoredOn(result.refundId) };
  }
  await attemptRefundNotice(notice);
  return { ...result, restoredPaise };
}

/** A class seat: its own unit, and what it may get back live or released. */
async function classSeatCreditBounds(
  tx: Tx,
  payment: { id: string; createdAt: Date },
  appointmentId: string,
  creditValue: number,
) {
  const seat = await tx.appointmentParticipant.findFirst({
    where: { paymentId: payment.id },
    select: { createdAt: true, status: true, sessionsPurchased: true },
  });
  const joinedAt =
    seat && seat.createdAt > payment.createdAt
      ? seat.createdAt
      : payment.createdAt;
  const ledger = await seatLedger(
    tx,
    {
      appointmentId,
      createdAt: joinedAt,
      sessionsPurchased: seat?.sessionsPurchased,
    },
    creditValue,
  );
  const seatLive = !!seat && !["CANCELLED", "REFUNDED"].includes(seat.status);
  const eligible = seatLive
    ? await missedUnmadeSessions(tx, appointmentId, joinedAt)
    : Math.max(0, ledger.heldCount - ledger.deliveredHeld);
  return { ledger, eligible, seatLive };
}

/**
 * A subscription: the unit is the credit over the plan's sessions, and only a
 * plan that ended (cancelled or run out) gets its undelivered sessions back.
 */
async function subscriptionCreditBounds(
  tx: Tx,
  appointmentId: string,
  creditValue: number,
) {
  const row = await tx.appointment.findUnique({
    where: { id: appointmentId },
    select: {
      subscription: {
        select: {
          status: true,
          sessionsTotal: true,
          subscriptionPlan: { select: { totalSessions: true } },
        },
      },
    },
  });
  const delivered = await tx.appointmentOccurrence.count({
    where: {
      appointmentId,
      deletedAt: null,
      completionStatus: { in: ["COMPLETED", "UNVERIFIED"] },
    },
  });
  const total = row?.subscription ? sessionsTotalOf(row.subscription) : 0;
  const status = row?.subscription?.status;
  const seatLive = status !== "CANCELLED" && status !== "COMPLETED";
  return {
    ledger: { unitPaise: BigInt(creditValue) / BigInt(Math.max(total, 1)) },
    eligible: seatLive ? 0 : Math.max(0, total - delivered),
    seatLive,
  };
}

async function restoredOn(refundId: string): Promise<number> {
  const row = await prisma.refund.findUnique({
    where: { id: refundId },
    select: { metadata: true },
  });
  const value = (row?.metadata as { restoredPaise?: unknown } | null)
    ?.restoredPaise;
  return typeof value === "number" ? value : 0;
}

const LIVE_SESSION = new Set<string>(["SCHEDULED", "COMPLETED", "UNVERIFIED"]);

/**
 * #1771 owner decision — sessions a live seat may get credit back for: ones
 * it held that the host cancelled, with no live make-up and not yet settled.
 */
async function missedUnmadeSessions(
  tx: Tx,
  appointmentId: string,
  joinedAt: Date,
): Promise<number> {
  const rows = await tx.appointmentOccurrence.findMany({
    where: { appointmentId, isTentative: false, deletedAt: null },
    select: {
      id: true,
      ordinal: true,
      startsAt: true,
      completionStatus: true,
      hostCancelledAt: true,
      voidedAt: true,
      seatsSettledAt: true,
    },
  });
  return rows.filter(
    (o) =>
      // #1569 — a voided session is a miss exactly like a host cancel.
      (o.hostCancelledAt || o.voidedAt) &&
      !o.seatsSettledAt &&
      o.startsAt > joinedAt &&
      !rows.some(
        (m) =>
          m.id !== o.id &&
          m.ordinal === o.ordinal &&
          LIVE_SESSION.has(m.completionStatus),
      ),
  ).length;
}

/**
 * #1771 K-5 — an ops return is bounded: a live seat by its missed, unmade
 * sessions; a released seat by every undelivered one. Less what came back.
 */
function assertReturnable(
  paymentId: string,
  ledger: { unitPaise: bigint },
  sessions: number,
  bound: {
    creditValue: number;
    stillUsed: number;
    eligible: number;
    seatLive: boolean;
  },
): void {
  const unit = Number(ledger.unitPaise);
  if (unit <= 0) {
    throw new RefundValidationError(
      `Payment ${paymentId} holds no session to return`,
      "NOTHING_TO_RETURN",
    );
  }
  const alreadyReturned = bound.creditValue - bound.stillUsed;
  const owed = unit * bound.eligible - alreadyReturned;
  if (unit * sessions > owed) {
    const max = Math.max(0, Math.floor(owed / unit));
    const which = bound.seatLive
      ? "missed sessions that were not made up"
      : "undelivered sessions";
    throw new RefundValidationError(
      `While this seat is ${bound.seatLive ? "live" : "released"}, credit comes back only for ${which}: at most ${max} more`,
      "AMOUNT_EXCEEDS_REFUNDABLE",
    );
  }
}

/**
 * In-ledger settlement of a fully-credit-funded cancellation (#1161).
 *
 * `applyRefundCascade` cannot serve this payment: its proportional machinery
 * divides by `Payment.amount`, which is 0 here (its zero-amount branch exists
 * precisely to short-circuit that, and only releases utilization). So this is
 * the ratio-1 special case, shaped like the cascade's Step 9 and mirroring —
 * leg for leg — how the credit funding was originally booked
 * (earnings-service.ts): the journal debited PLATFORM_PROMO for the
 * REFERRAL_CREDIT legs (or DISCOUNT on legacy rows without legs) and credited
 * CONSULTANT_PAYABLE per party, ORG_PAYABLE per org, GST_PAYABLE and the
 * platform fee. The reversal credits PLATFORM_PROMO back and debits those
 * payables, with PLATFORM_FEE absorbing the residual so the txn balances to
 * the paise.
 *
 * The payables' source rows net first (earnings → REFUNDED, org clawback when
 * already paid out) so payout math and ledger stay coherent — EARNINGS_LEDGER_
 * DRIFT reconciles exactly this pairing. A free_ booking carries no overage
 * side-charges, so there is no Step-7.6 credit-back; its consumer invoice is
 * reversed by a credit note for the same share of the credit-funded value.
 *
 * No-op when no earnings rows exist: without them neither did the consultant
 * pipeline nor the booking journal run, so there is nothing to invert —
 * posting anyway would credit PLATFORM_PROMO against a debit that never
 * happened.
 */
async function reverseFreeCreditSettlement(
  tx: Tx,
  input: {
    paymentId: string;
    refundId: string;
    initiatedByUserId: string | null;
    reason: string;
    /** #1771 K-5 — reverse only num/den of the booking (a partial credit return). */
    share?: { num: number; den: number };
    /** This return exhausts the credit, so it takes the DISCOUNT's exact remainder. */
    completes?: boolean;
  },
): Promise<void> {
  const share = input.share;
  const part = (paise: number) =>
    share
      ? Number((BigInt(paise) * BigInt(share.num)) / BigInt(share.den))
      : paise;
  const payment = await tx.payment.findUniqueOrThrow({
    where: { id: input.paymentId },
    select: {
      originalAmount: true,
      taxAmount: true,
      createdAt: true,
      legs: { select: { source: true, amountPaise: true } },
      earnings: {
        select: {
          id: true,
          consultantProfileId: true,
          consultantSharePaise: true,
          refundedShareAmount: true,
          status: true,
          payoutId: true,
          payout: {
            select: {
              status: true,
              amount: true,
              tdsDeducted: true,
              clawbackInitiatedAt: true,
            },
          },
        },
      },
      organizationEarnings: {
        select: {
          id: true,
          organizationId: true,
          orgSharePaise: true,
          refundedAmountPaise: true,
          status: true,
          orgPayoutId: true,
          orgPayout: {
            select: {
              status: true,
              clawbackInitiatedAt: true,
              netPayoutPaise: true,
            },
          },
        },
      },
    },
  });

  // The tax-inclusive value the credits funded, which is what the invoice billed.
  const promoTotal = part(
    payment.legs.reduce(
      (s, l) =>
        l.source === "REFERRAL_CREDIT" && l.amountPaise > 0
          ? s + l.amountPaise
          : s,
      0,
    ),
  );
  const discountBack =
    promoTotal > 0
      ? 0
      : part(payment.originalAmount + (payment.taxAmount ?? 0));

  await mintConsumerCreditNote(tx, {
    paymentId: input.paymentId,
    refundId: input.refundId,
    amountPaise: promoTotal + discountBack,
    reason: input.reason,
  });

  if (
    payment.earnings.length === 0 &&
    payment.organizationEarnings.length === 0
  )
    return;

  // Consultant earnings net in full via the shared CAS writer.
  // `appliedByEarning` is what each row ACTUALLY absorbed (<= request); the TDS
  // filing and counter-posting below must read it, never the request.
  const appliedByEarning = new Map<string, number>();
  const consultantClawbacks = new Map<string, PendingConsultantClawback>();
  for (const earnings of payment.earnings) {
    const delta = part(earnings.consultantSharePaise);
    // #CASC — the shared writer repeats the cap and legal-source predicate in
    // the WHERE and asserts the transition itself, so a concurrent refund wins.
    const reversal = await applyCappedEarningReversal(tx, earnings, delta);
    appliedByEarning.set(earnings.id, reversal.reversedPaise);
    if (reversal.lostRace) {
      console.warn(
        `Earnings ${earnings.id}: credit-funded cancel CAS lost, ` +
          `${reversal.reversedPaise} paise applied of ${delta} ` +
          `(${reversal.refundedShareAmount}/${earnings.consultantSharePaise}).`,
      );
    }
    if (earnings.payoutId && reversal.reversedPaise > 0) {
      // Full reversal of this share → full TDS reversal for it; the helper's
      // own dedup + original-cap keeps a re-run bounded. Numerator is the
      // APPLIED paise; skipped at 0 so a refused CAS nets no withholding out.
      await recordTdsReversal(tx, {
        payoutId: earnings.payoutId,
        consultantProfileId: earnings.consultantProfileId,
        earningsId: earnings.id,
        refundAmountPaise: reversal.reversedPaise,
        paymentAmountPaise: earnings.consultantSharePaise,
        refundId: input.refundId,
      });
    }

    accumulatePaidConsultantClawback(
      consultantClawbacks,
      earnings,
      reversal.reversedPaise,
    );
  }

  await applyPaidConsultantClawbacks(tx, consultantClawbacks, {
    refundId: input.refundId,
    reason: `credit-funded refund (${input.refundId})`,
  });

  // Org earnings (the consultant's host org / collaborator orgs — not a
  // sponsor; referral credits never fund org-sponsored checkouts). Mirrors
  // cascade Step 7 including the COMPLETED-payout clawback record.
  //
  // `appliedByOrgEarning` is the org twin of `appliedByEarning` above.
  const appliedByOrgEarning = new Map<string, number>();
  for (const orgEarn of payment.organizationEarnings) {
    const orgDelta = part(orgEarn.orgSharePaise);
    // #CASC — same shared CAS writer as the consultant rows (org column names);
    // it asserts the transition itself before writing.
    const orgReversal = await applyCappedOrgEarningReversal(
      tx,
      orgEarn,
      orgDelta,
    );
    appliedByOrgEarning.set(orgEarn.id, orgReversal.reversedPaise);
    if (orgReversal.lostRace) {
      console.warn(
        `Org earnings ${orgEarn.id}: credit-funded cancel CAS lost, ` +
          `${orgReversal.reversedPaise} paise applied of ${orgDelta} ` +
          `(${orgReversal.refundedAmountPaise}/${orgEarn.orgSharePaise}).`,
      );
    }
    const orgApplied = orgReversal.reversedPaise;

    if (
      orgEarn.orgPayoutId &&
      orgEarn.orgPayout?.status === "COMPLETED" &&
      orgApplied > 0
    ) {
      // Gated on the APPLIED figure: a zero must post nothing, as `postLedgerTxn` throws on it.
      await clawBackCompletedOrgPayout(tx, {
        orgPayout: { ...orgEarn.orgPayout, id: orgEarn.orgPayoutId },
        organizationId: orgEarn.organizationId,
        orgEarningsId: orgEarn.id,
        paymentId: input.paymentId,
        refundId: input.refundId,
        grossPaise: orgApplied,
        amountPaise: orgApplied,
        label: "Credit-funded cancellation clawback",
        initiatedByUserId: input.initiatedByUserId,
      });
    }
  }

  // The counter-posting. Funding returns to PLATFORM_PROMO (the account the
  // REFERRAL_CREDIT legs were debited to); legacy pre-legs payments booked
  // their gross as DISCOUNT instead (#1003 shape).
  const credits: Posting[] = [];
  if (promoTotal > 0) {
    credits.push({
      account: { kind: "PLATFORM_PROMO" },
      direction: "CREDIT",
      amountPaise: promoTotal,
    });
    // A coupon on a credit-funded booking was booked to DISCOUNT; it returns with the credits.
    const { discountBackPaise } = await refundReversalBasis(
      tx,
      input.paymentId,
      part,
      input.completes ?? !share,
    );
    if (discountBackPaise > 0) {
      credits.push({
        account: { kind: "DISCOUNT" },
        direction: "CREDIT",
        amountPaise: discountBackPaise,
      });
    }
  } else if (discountBack > 0) {
    credits.push({
      account: { kind: "DISCOUNT" },
      direction: "CREDIT",
      amountPaise: discountBack,
    });
  }

  const fundingTotal = credits.reduce((s, c) => s + c.amountPaise, 0);
  // APPLIED, not requested: `platformPlug` absorbs the un-clawed remainder on
  // PLATFORM_FEE instead of over-debiting the payables.
  const consRev = payment.earnings.reduce(
    (s, e) => s + (appliedByEarning.get(e.id) ?? 0),
    0,
  );
  const orgRev = payment.organizationEarnings.reduce(
    (s, o) => s + (appliedByOrgEarning.get(o.id) ?? 0),
    0,
  );
  const taxPaise = payment.taxAmount ?? 0;
  const gstRev =
    taxPaise > 0 && isPastGstCreditNoteCutoff(payment.createdAt)
      ? 0
      : part(taxPaise);
  // PLATFORM_FEE is the residual plug (cascade Step 9 convention): positive →
  // the platform gives back its fee slice; negative (discount gap between the
  // funding and the shares) → the fee credit absorbs the shortfall.
  const platformPlug = fundingTotal - consRev - orgRev - gstRev;

  const debits: Posting[] = [];
  for (const earnings of payment.earnings) {
    // APPLIED paise, not `part(consultantSharePaise)` (the request) — debiting
    // the payable for paise the CAS never applied is the ledger-vs-earnings
    // divergence `reconcile-ledgers` raises as EARNINGS_LEDGER_DRIFT.
    const delta = appliedByEarning.get(earnings.id) ?? 0;
    if (delta > 0) {
      debits.push({
        account: {
          kind: "CONSULTANT_PAYABLE",
          consultantProfileId: earnings.consultantProfileId,
        },
        direction: "DEBIT",
        amountPaise: delta,
      });
    }
  }
  for (const orgEarn of payment.organizationEarnings) {
    // APPLIED paise, not `part(orgSharePaise)` (the request) — debiting the
    // payable for paise the CAS never applied is the ledger-vs-earnings
    // divergence `reconcile-ledgers` raises as EARNINGS_LEDGER_DRIFT.
    const orgDelta = appliedByOrgEarning.get(orgEarn.id) ?? 0;
    if (orgDelta > 0) {
      debits.push({
        account: {
          kind: "ORG_PAYABLE",
          organizationId: orgEarn.organizationId,
        },
        direction: "DEBIT",
        amountPaise: orgDelta,
      });
    }
  }
  if (gstRev > 0) {
    debits.push({
      account: { kind: "GST_PAYABLE" },
      direction: "DEBIT",
      amountPaise: gstRev,
    });
  }
  if (platformPlug > 0) {
    debits.push({
      account: { kind: "PLATFORM_FEE" },
      direction: "DEBIT",
      amountPaise: platformPlug,
    });
  } else if (platformPlug < 0) {
    credits.push({
      account: { kind: "PLATFORM_FEE" },
      direction: "CREDIT",
      amountPaise: -platformPlug,
    });
  }

  const debitTotal = debits.reduce((s, d) => s + d.amountPaise, 0);
  const creditTotal = credits.reduce((s, c) => s + c.amountPaise, 0);
  // #1218-triage — a fully-zero settlement (zero-share earnings rows only)
  // produces empty postings on BOTH sides: that is a legitimate nothing-to-
  // journal outcome, not an imbalance. Only a one-sided non-empty total is
  // a real logic bug worth rolling back for.
  if (debits.length === 0 && credits.length === 0) {
    console.log(
      `ℹ️ free-credit reversal for payment ${input.paymentId}: zero-value settlement — no journal posted`,
    );
    return;
  }
  if (debitTotal === 0 || debitTotal !== creditTotal) {
    // Unreachable given the plug — a mismatch is a real logic bug. Throwing
    // rolls back the whole Serializable tx (Refund row included) for a clean
    // retry rather than half-applying the reversal.
    throw new Error(
      `free-credit reversal unbalanced for payment ${input.paymentId}: Dr ${debitTotal} Cr ${creditTotal}`,
    );
  }

  await postLedgerTxn(tx, {
    idempotencyKey: `refund:${input.refundId}`,
    kind: "REFUND",
    paymentId: input.paymentId,
    postings: [...debits, ...credits],
  });
}

/**
 * In-ledger reversal of an org-funded booking payment.
 *
 * Mirrors the shape `reverseClassMulti` uses per child — mint the Refund row,
 * run the proven cascade against it, flip it SUCCEEDED — inside one
 * Serializable transaction, which is what `applyRefundCascade` requires for
 * race-safety. There is no gateway leg to wait on, so unlike `refundPayment`
 * this settles in a single phase.
 */
async function refundInternalFundedPayment(
  input: {
    paymentId: string;
    amountPaise?: number;
    reason: string;
    initiatedByUserId?: string | null;
    dedupeKey?: string;
    supportRecommendationId?: string;
    keepSeat?: boolean;
    keepSeatIfPartial?: boolean;
  } & OwedMarkerInput,
): Promise<{
  result: BookingRefundResult;
  endsSeat: boolean;
  intentGeneration: Date | null;
}> {
  const payment = await prisma.payment.findUnique({
    where: { id: input.paymentId, deletedAt: null },
    select: {
      id: true,
      userId: true,
      organizationId: true,
      amount: true,
      currency: true,
      paymentStatus: true,
      paymentGateway: true,
      displayCurrencyAtCheckout: true,
      exchangeRateAtCheckout: true,
    },
  });
  if (!payment) {
    throw new RefundValidationError(
      `Payment ${input.paymentId} not found`,
      "PAYMENT_NOT_FOUND",
    );
  }
  if (payment.paymentStatus !== PaymentStatus.SUCCEEDED) {
    throw new RefundValidationError(
      `Payment ${input.paymentId} is not SUCCEEDED (status=${payment.paymentStatus}); cannot refund`,
      "PAYMENT_NOT_SUCCEEDED",
    );
  }

  // Staged inside the tx, attempted after it; a retried attempt re-stages.
  let notice: StagedRefundNotice | null = null;
  // An explicit amount is known up front, so its receipt renders before the transaction.
  const receipt =
    input.amountPaise === undefined
      ? null
      : await prepareRefundProcessedEmail(
          refundReceiptArgs(payment, input.amountPaise, input.reason),
        ).catch(() => null);
  // Loaded before the transaction, so no module load runs while it holds the connection.
  const { persistRefundRevocationInTx } =
    await import("@/lib/stream/access-revocation");
  const result = await withSerializableRetry(() =>
    prisma.$transaction(
      async (tx) => {
        // Re-derive the balance inside the Serializable tx so two concurrent
        // reversals cannot oversubscribe. A synthetic intent can never carry a
        // gateway dispute, so — unlike refundPayment — there is no chargeback
        // term to net out here.
        const priorRefunds = await tx.refund.findMany({
          where: {
            paymentId: payment.id,
            status: { in: [RefundStatus.SUCCEEDED, RefundStatus.PENDING] },
          },
          select: { amountPaise: true },
        });
        const refundable =
          payment.amount - priorRefunds.reduce((a, r) => a + r.amountPaise, 0);
        if (refundable <= 0) {
          throw new RefundValidationError(
            `Payment ${payment.id} has no refundable balance`,
            "ALREADY_FULLY_REFUNDED",
          );
        }

        const requested = input.amountPaise ?? refundable;
        if (requested <= 0) {
          throw new RefundValidationError(
            `Refund amount must be positive; got ${requested}`,
            "INVALID_AMOUNT",
          );
        }
        if (requested > refundable) {
          throw new RefundValidationError(
            `Refund amount ${requested} exceeds refundable ${refundable} on payment ${payment.id}`,
            "AMOUNT_EXCEEDS_REFUNDABLE",
          );
        }
        const settledOwed = await claimOwedMarker(tx, payment.id, input, {
          kind: "amount",
          handPaise: requested,
          refundableBeforePaise: refundable,
        });

        const refundRow = await tx.refund.create({
          data: {
            paymentId: payment.id,
            amountPaise: requested,
            currency: payment.currency,
            reason: input.reason,
            status: RefundStatus.PENDING,
            // No gateway ever mints an id for these, so the row owns its own.
            refundId: `internal_${globalThis.crypto.randomUUID()}`,
            dedupeKey: input.dedupeKey ?? null,
            ...(input.supportRecommendationId
              ? {
                  supportRecommendation: {
                    connect: { id: input.supportRecommendationId },
                  },
                }
              : {}),
            paymentGateway: payment.paymentGateway,
            exchangeRateAtRefund: payment.exchangeRateAtCheckout,
            displayCurrency: payment.displayCurrencyAtCheckout,
            metadata: {
              initiatedByUserId: input.initiatedByUserId ?? null,
              source: "internal-funded",
              ...(settledOwed ? { settledOwed } : {}),
            } as Prisma.InputJsonValue,
          },
        });

        await applyReversal(tx, {
          source: { kind: "BOOKING", paymentId: payment.id },
          amountPaise: requested,
          reason: input.reason,
          refundId: refundRow.id,
          initiatedByUserId: input.initiatedByUserId ?? null,
        });

        await tx.refund.updateMany({
          where: { id: refundRow.id, status: RefundStatus.PENDING },
          data: { status: RefundStatus.SUCCEEDED },
        });

        // Same ordering rule as refundPayment Phase 3b: credit restoration
        // reads the cumulative SUCCEEDED refund total, so it must run after
        // the flip above or it under-restores.
        await reverseCreditsForPayment(
          payment.id,
          tx,
          requested,
          payment.amount,
          refundRow.id,
        );

        // Read inside the Serializable tx, so two partials that together return everything end the seat.
        const partial = requested < refundable;
        const endsSeat =
          !input.keepSeat && !(input.keepSeatIfPartial && partial);
        let intentGeneration: Date | null = null;
        if (endsSeat) {
          await transitionParticipant(
            tx,
            { paymentId: payment.id },
            "REFUNDED",
            refundedSeat(input.initiatedByUserId),
          );
          // Commits with the seat stamp, so a refunded seat always has its revocation owed.
          intentGeneration = await persistRefundRevocationInTx(tx, {
            refundId: refundRow.id,
            payerUserId: payment.userId,
          });
        }
        notice = await stageRefundNotice(
          tx,
          payment,
          requested,
          noticeReason(settledOwed, input.reason),
          receipt,
        );
        return {
          result: {
            refundId: refundRow.id,
            amountRefundedPaise: requested,
            rail: "INTERNAL" as const,
            ...(settledOwed ? { settledOwed } : {}),
          },
          endsSeat,
          intentGeneration,
        };
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        maxWait: 10_000,
        timeout: 15_000,
      },
    ),
  );
  await attemptRefundNotice(notice);
  return result;
}
