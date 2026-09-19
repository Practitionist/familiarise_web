import {
  reportSentryError,
  reportSentryMessage,
} from "@/lib/observability/report";
import type { Tx } from "@/lib/prisma";
/**
 * Unified reversal engine (#776 §C / ARCH #4).
 *
 * Pre-MVP, "undo money" was a per-path cascade: `refund.ts` reversed a single
 * booking payment, overage/payout-clawback/invoice-void each had bespoke logic,
 * and multi-booking (CLASS) refunds — which have no single `paymentId` — were
 * skipped entirely, drifting cap counts and the ledger. This module is the one
 * front door every reversal flows through:
 *
 *   applyReversal(tx, { source, amountPaise, reason, refundId })
 *
 * Each `source` kind resolves to the right domain reversal but shares the same
 * idempotent ledger counter-posting discipline (keyed off `refundId`), so a
 * retry is always a no-op and reconcile can assert coherence
 * (REFUND_BOOKING_COHERENCE).
 *
 * The deep booking cascade still lives in `refund.ts` (`applyRefundCascade`) —
 * it's proven and heavily tested; this engine DISPATCHES to it rather than
 * re-implementing it. New capability here: CLASS_MULTI (fan a single logical
 * refund across the child payments of a consolidated CLASS purchase).
 *
 * Production callers (#776 §C):
 *   - CLASS_MULTI       — `refundWholeEventPayments` (lib/payments/operations/
 *                         event-refunds.ts), for the INTERNAL (org-funded) seats
 *                         of a cancelled class/webinar. Gateway/card seats do NOT
 *                         come here — they credit the card via `refundPayment`,
 *                         which this engine never calls (reverseClassMulti marks
 *                         its child refunds SUCCEEDED with no gateway leg).
 *   - PAYOUT_CLAWBACK   — the dispute-lost branch of handleDisputeUpdated.
 *   - BOOKING / OVERAGE — single-payment reversals still flow through
 *                         `refundPayment` (it owns the gateway phases); nothing
 *                         calls applyReversal for those from a route.
 */

import {
  Prisma,
  RefundStatus,
  type Currency,
  type PaymentGateway,
} from "@prisma/client";
import { applyRefundCascade, type ApplyRefundCascadeResult } from "./refund";
import { postLedgerTxn } from "@/lib/payments/ledger/post";
import {
  REFUNDABLE_BALANCE_SELECT,
  refundableBalancePaise,
} from "@/lib/payments/refundable-balance";
import { sumPaise } from "@/lib/payments/utils/money";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";
import { recordSystemError } from "@/lib/enterprise/system-events";

type ReversalSource =
  // A single booking payment (the common case).
  | { kind: "BOOKING"; paymentId: string }
  // An overage side-charge — itself a Payment (parentPaymentId-linked), so it
  // reverses through the booking cascade on that payment id.
  | { kind: "OVERAGE"; overagePaymentId: string }
  // Gateway-side payout clawback (e.g. a lost dispute on an org-funded booking).
  | { kind: "PAYOUT_CLAWBACK"; orgPayoutId: string; organizationId: string }
  // A consolidated CLASS purchase: many child payments, no single paymentId.
  | { kind: "CLASS_MULTI"; paymentIds: string[] };

export interface ApplyReversalInput {
  source: ReversalSource;
  /** Total paise to reverse. For CLASS_MULTI it's split across children. */
  amountPaise: number;
  reason: string;
  /** Existing Refund row id when one drives this reversal; else null. */
  refundId: string;
  initiatedByUserId?: string | null;
}

export interface ApplyReversalResult {
  kind: ReversalSource["kind"];
  /** Per-cascade results (one per payment touched). */
  cascades: ApplyRefundCascadeResult[];
  /** Child Refund row ids created by CLASS_MULTI (one per reversed child). */
  childRefundIds: string[];
  /** True if a payout clawback ledger posting was made. */
  clawbackPosted: boolean;
}

/**
 * The single reversal front door. Must be called inside a Serializable tx
 * (the booking cascade requires it for race-safety).
 */
export async function applyReversal(
  tx: Tx,
  input: ApplyReversalInput,
): Promise<ApplyReversalResult> {
  switch (input.source.kind) {
    case "BOOKING": {
      const cascade = await applyRefundCascade(tx, {
        paymentId: input.source.paymentId,
        refundId: input.refundId,
        amountPaise: input.amountPaise,
        reason: input.reason,
        initiatedByUserId: input.initiatedByUserId ?? null,
      });
      return {
        kind: "BOOKING",
        cascades: [cascade],
        childRefundIds: [],
        clawbackPosted: false,
      };
    }

    case "OVERAGE": {
      // The overage charge IS a Payment; reverse it like any booking.
      const cascade = await applyRefundCascade(tx, {
        paymentId: input.source.overagePaymentId,
        refundId: input.refundId,
        amountPaise: input.amountPaise,
        reason: input.reason,
        initiatedByUserId: input.initiatedByUserId ?? null,
      });
      return {
        kind: "OVERAGE",
        cascades: [cascade],
        childRefundIds: [],
        clawbackPosted: false,
      };
    }

    case "CLASS_MULTI": {
      const { cascades, childRefundIds } = await reverseClassMulti(
        tx,
        input,
        input.source.paymentIds,
      );
      return {
        kind: "CLASS_MULTI",
        cascades,
        childRefundIds,
        clawbackPosted: false,
      };
    }

    case "PAYOUT_CLAWBACK": {
      const posted = await reversePayoutClawback(
        tx,
        input,
        input.source.orgPayoutId,
        input.source.organizationId,
      );
      return {
        kind: "PAYOUT_CLAWBACK",
        cascades: [],
        childRefundIds: [],
        clawbackPosted: posted,
      };
    }

    default: {
      const _exhaustive: never = input.source;
      throw new Error(
        `Unhandled ReversalSource: ${JSON.stringify(_exhaustive)}`,
      );
    }
  }
}

/** One child payment of a CLASS_MULTI batch with what is still refundable on it. */
export interface RefundableBalance {
  id: string;
  amount: number;
  currency: Currency;
  paymentGateway: PaymentGateway;
  displayCurrencyAtCheckout: string | null;
  exchangeRateAtCheckout: number | null;
  /** `amount` net of PENDING/SUCCEEDED refunds and LOST/CHARGE_REFUNDED disputes, floored at 0. */
  refundablePaise: number;
}

/**
 * The per-payment refundable balance, read through the caller's transaction so
 * the clamp and the write share one snapshot (#1583 C-P0-03). Shared by
 * `reverseClassMulti` and `refundWholeEventPayments` so the batch total and the
 * per-child headroom can never be computed from two different readings.
 */
export async function readRefundableBalances(
  tx: Pick<Tx, "payment">,
  paymentIds: string[],
): Promise<RefundableBalance[]> {
  if (paymentIds.length === 0) return [];
  const payments = await tx.payment.findMany({
    where: { id: { in: paymentIds } },
    select: {
      id: true,
      amount: true,
      currency: true,
      paymentGateway: true,
      // #781 §C — carry the FX snapshot onto each child refund (mirrors refund.ts).
      displayCurrencyAtCheckout: true,
      exchangeRateAtCheckout: true,
      ...REFUNDABLE_BALANCE_SELECT,
    },
  });
  return payments.map(({ refunds, disputes, ...payment }) => ({
    ...payment,
    refundablePaise: refundableBalancePaise(payment.amount, {
      refunds,
      disputes,
    }),
  }));
}

/**
 * Fan a single logical refund across the child payments of a consolidated
 * CLASS purchase. The caller resolves the group → `paymentIds`; we distribute
 * `amountPaise` proportionally by each payment's REFUNDABLE balance, create one
 * Refund row per child (so each carries its own gateway/ledger trail), and run
 * the proven cascade on each. The rounding remainder is walked across children
 * that still have headroom so the children sum exactly to `amountPaise`.
 *
 * Clamps per child to the refundable balance, so a second whole-event call is
 * a no-op rather than a second cascade (#1583 C-P0-03): a seat that was already
 * refunded contributes no share and gets no Refund row.
 */
async function reverseClassMulti(
  tx: Tx,
  input: ApplyReversalInput,
  paymentIds: string[],
): Promise<{
  cascades: ApplyRefundCascadeResult[];
  childRefundIds: string[];
}> {
  if (paymentIds.length === 0) return { cascades: [], childRefundIds: [] };

  const payments = (await readRefundableBalances(tx, paymentIds)).filter(
    (p) => p.refundablePaise > 0,
  );
  const totalRefundable = payments.reduce((s, p) => s + p.refundablePaise, 0);
  if (totalRefundable <= 0) return { cascades: [], childRefundIds: [] };

  // Fail fast on an over-refund. Without this the per-child floor shares would
  // exceed their own headroom and crash deep inside a child cascade (after some
  // children already processed) — a clear upfront error is far easier to debug.
  if (input.amountPaise > totalRefundable) {
    throw new Error(
      `CLASS_MULTI reversal amount ${input.amountPaise} exceeds the batch's refundable balance ${totalRefundable}`,
    );
  }

  // Proportional split by refundable balance. The floor() per child loses up
  // to <1 paise each, so distribute the rounding remainder one paise at a time
  // to children that still have headroom (share < refundable) — never dump it
  // all on the last child, which could be tiny and overflow its own balance,
  // tripping applyRefundCascade's `requested > refundable` guard and crashing
  // the whole reversal. Total headroom (totalRefundable − assigned) always
  // covers the remainder for any amountPaise <= totalRefundable, so one pass
  // suffices.
  // The product of two paise figures can leave the safe-integer range long
  // before either figure does, so the share is computed in BigInt and every
  // boundary value is asserted back into the safe range (#780 posture).
  for (const v of [input.amountPaise, totalRefundable]) {
    if (!Number.isSafeInteger(v)) {
      throw new Error(`CLASS_MULTI reversal figure outside safe range: ${v}`);
    }
  }
  const shares = payments.map((p) => ({
    payment: p,
    share: sumPaise(
      (BigInt(input.amountPaise) * BigInt(p.refundablePaise)) /
        BigInt(totalRefundable),
    ),
  }));
  let remainder = input.amountPaise - shares.reduce((s, x) => s + x.share, 0);
  for (let i = 0; remainder > 0 && i < shares.length; i++) {
    const headroom = shares[i].payment.refundablePaise - shares[i].share;
    const add = Math.min(headroom, remainder);
    shares[i].share += add;
    remainder -= add;
  }

  const results: ApplyRefundCascadeResult[] = [];
  const childRefundIds: string[] = [];
  for (const { payment, share } of shares) {
    if (share <= 0) continue;
    // One Refund row per child so partial-class refunds reverse cleanly and a
    // later reconcile can tie each child's reversal to its own row.
    const childRefund = await tx.refund.create({
      data: {
        paymentId: payment.id,
        amountPaise: share,
        currency: payment.currency,
        reason: input.reason,
        status: RefundStatus.PENDING,
        refundId: `app_${globalThis.crypto.randomUUID()}`,
        paymentGateway: payment.paymentGateway,
        // #781 §C — preserve the buyer's FX snapshot on the child refund row.
        exchangeRateAtRefund: payment.exchangeRateAtCheckout,
        displayCurrency: payment.displayCurrencyAtCheckout,
        metadata: {
          initiatedByUserId: input.initiatedByUserId ?? null,
          source: "class-multi",
          parentRefundId: input.refundId,
        } as Prisma.InputJsonValue,
      },
    });
    const cascade = await applyRefundCascade(tx, {
      paymentId: payment.id,
      refundId: childRefund.id,
      amountPaise: share,
      reason: input.reason,
      initiatedByUserId: input.initiatedByUserId ?? null,
    });
    await tx.refund.update({
      where: { id: childRefund.id },
      data: { status: RefundStatus.SUCCEEDED },
    });
    results.push(cascade);
    childRefundIds.push(childRefund.id);
  }
  return { cascades: results, childRefundIds };
}

/**
 * Gateway-side payout clawback. The original payout posted
 * `Dr ORG_PAYABLE / Cr CASH`; clawback recovers cash:
 * `Dr CASH / Cr ORG_PAYABLE`. Idempotent on `clawback:<refundId>:<payoutId>`.
 * Stamps the clawback amount/timestamp on the payout and writes an audit row.
 */
async function reversePayoutClawback(
  tx: Tx,
  input: ApplyReversalInput,
  orgPayoutId: string,
  organizationId: string,
): Promise<boolean> {
  if (input.amountPaise <= 0) return false;

  const payout = await tx.organizationPayout.findUnique({
    where: { id: orgPayoutId },
    select: { id: true, clawbackInitiatedAt: true },
  });
  if (!payout) {
    reportSentryMessage(
      "reversePayoutClawback: target OrganizationPayout not found",
      {
        subsystem: "payments",
        level: "warning",
        extra: { orgPayoutId, refundId: input.refundId },
      },
    );
    return false;
  }

  await tx.organizationPayout.update({
    where: { id: orgPayoutId },
    data: {
      clawbackAmountPaise: { increment: input.amountPaise },
      clawbackInitiatedAt: payout.clawbackInitiatedAt ? undefined : new Date(),
    },
  });

  await tx.orgAuditLog.create({
    data: {
      organizationId,
      actorMembershipId: null,
      category: "PAYOUT",
      action: AUDIT_ACTIONS.PAYOUT.PAYOUT_CLAWBACK,
      description: `Payout clawback: ${input.amountPaise} paise from payout ${orgPayoutId} (${input.reason})`,
      details: {
        refundId: input.refundId,
        orgPayoutId,
        amountPaise: input.amountPaise,
        initiatedByUserId: input.initiatedByUserId ?? null,
      } as Prisma.InputJsonValue,
    },
  });

  await postPayoutClawback(tx, {
    refundId: input.refundId,
    payoutId: orgPayoutId,
    amountPaise: input.amountPaise,
    organizationId,
  });

  return true;
}

/**
 * The clawback journal: `Dr CASH / Cr ORG_PAYABLE`, idempotent on
 * `clawback:<refundId>:<payoutId>`. #1582 C-P1-02c — shared by the dispute
 * path and both refund paths so the counter the reconciler compares against
 * (`stepClawbackGap`) always has a matching posting. INR-only, so the ledger
 * account currency is left unset as post.ts documents.
 */
export async function postPayoutClawback(
  tx: Tx,
  input: {
    refundId: string;
    payoutId: string;
    amountPaise: number;
    organizationId: string;
  },
): Promise<void> {
  const { refundId, payoutId, amountPaise, organizationId } = input;
  // The counter-post is part of the reversal, not a side effect: report, then
  // rethrow so the enclosing tx rolls back — an unbalanced journal never commits (#1583 C-P1-09).
  try {
    await postLedgerTxn(tx, {
      idempotencyKey: `clawback:${refundId}:${payoutId}`,
      kind: "ORG_PAYOUT",
      payoutId,
      postings: [
        {
          account: { kind: "CASH" },
          direction: "DEBIT",
          amountPaise,
        },
        {
          account: { kind: "ORG_PAYABLE", organizationId },
          direction: "CREDIT",
          amountPaise,
        },
      ],
    });
  } catch (err) {
    reportSentryError(err, { subsystem: "payments", level: "fatal" });
    console.error(
      `[ledger] payout clawback posting FAILED for payout ${payoutId} (refund tx rolls back): ${err instanceof Error ? err.message : String(err)}`,
    );
    // #776 — page immediately on dual-write drift; fire-and-forget. #1582
    // B-P1-02 — global client on purpose: the rethrow rolls the tx back.
    void recordSystemError({
      organizationId,
      category: "LEDGER",
      summary: `Payout clawback ledger posting failed for payout ${payoutId}`,
      err,
      context: { orgPayoutId: payoutId, refundId },
    }).catch(() => {});
    throw err;
  }
}
