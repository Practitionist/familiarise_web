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
 *   - CONSULTANT_CLAWBACK — the same branch's consultant rail: a lost dispute on
 *                         an earning a COMPLETED ConsultantPayout already paid.
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
import { recordSystemErrorSafe } from "@/lib/enterprise/system-events";

type ReversalSource =
  // A single booking payment (the common case).
  | { kind: "BOOKING"; paymentId: string }
  // An overage side-charge — itself a Payment (parentPaymentId-linked), so it
  // reverses through the booking cascade on that payment id.
  | { kind: "OVERAGE"; overagePaymentId: string }
  // Gateway-side payout clawback (e.g. a lost dispute on an org-funded booking).
  | { kind: "PAYOUT_CLAWBACK"; orgPayoutId: string; organizationId: string }
  // The consultant mirror of PAYOUT_CLAWBACK: a lost dispute on an earning a
  // COMPLETED ConsultantPayout already paid out. Same idempotency-key
  // convention, same audit discipline, same append-only counter-transaction —
  // but the cash CANNOT be pulled on this rail, so the recovery is booked as a
  // receivable rather than a CASH debit. See {@link postConsultantPayoutClawback}.
  | {
      kind: "CONSULTANT_CLAWBACK";
      consultantPayoutId: string;
      consultantProfileId: string;
    }
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

    case "CONSULTANT_CLAWBACK": {
      const posted = await reverseConsultantPayoutClawback(
        tx,
        input,
        input.source.consultantPayoutId,
        input.source.consultantProfileId,
      );
      return {
        kind: "CONSULTANT_CLAWBACK",
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
    void recordSystemErrorSafe({
      organizationId,
      category: "LEDGER",
      summary: `Payout clawback ledger posting failed for payout ${payoutId}`,
      err,
      context: { orgPayoutId: payoutId, refundId },
    });
    throw err;
  }
}

/**
 * The idempotency key for a consultant payout clawback. Same convention as the
 * org clawback, so `reconcile-ledgers`' `clawback:*` prefix query and a future
 * `ConsultantPayout.clawbackAmountPaise` counter read the same shape.
 *
 * Unique per (refund, payout): `refundId` is the driver's id — the dispute path
 * passes `dispute:<disputeId>` — so one lost dispute recovers from a given
 * payout at most once no matter how many deliveries arrive, while two different
 * disputes against the same payout post twice, which is correct because each
 * reversed earnings of its own.
 */
export function consultantClawbackKey(
  refundId: string,
  consultantPayoutId: string,
): string {
  return `clawback:${refundId}:${consultantPayoutId}`;
}

/**
 * SEAM — the automatic consultant equivalent of the org clawback, for a
 * ConsultantPayout whose cash already left.
 *
 * Shape mirrors `reversePayoutClawback` (idempotent ledger counter-post keyed
 * `clawback:<refundId>:<payoutId>`, durable audit row on failure, one
 * append-only journal entry) with ONE economic difference, forced by the two
 * rails behaving differently:
 *
 *   - the ORG rail can reverse-transfer, so its clawback is `Dr CASH /
 *     Cr ORG_PAYABLE` and the cash genuinely comes back;
 *   - the CONSULTANT rail has no reverse-transfer mechanism at all (the R-06 /
 *     E-05 posture), so debiting CASH here would assert money the platform does
 *     not hold and would leave the recovery unreconcilable against anything real.
 *
 * So the recovery lands as an explicit receivable instead:
 *
 *   Dr CONSULTANT_RECEIVABLE(consultant)  the clawback owed to the platform
 *      Cr PLATFORM_FEE                    the platform's take, given back
 *
 * CONSULTANT_RECEIVABLE is its own account kind, consultant-scoped by
 * construction (the deterministic id is
 * `CONSULTANT_RECEIVABLE|_|<profileId>|INR`). An earlier draft parked this on
 * ORG_RECEIVABLE with a `consultantProfileId` scope; that was rejected — the
 * chart of accounts defines ORG_RECEIVABLE as *an INVOICE-funded org owes us*,
 * so a consultant balance in an org-scoped kind misreports both the org
 * receivables query and the chart itself, and the isolation from
 * `getOrgReceivables` was an accident of id shape rather than a design. The
 * kind was added rather than borrowed. PLATFORM_FEE takes the credit because
 * it is the only credit-normal account that already carries this loss as the
 * platform's take, and it is already the house residual plug in `refund.ts`
 * and `applyB2cChargebackReversal`.
 *
 * The amount is NET of TDS. The transfer was net (`netAmount` on the payout),
 * `recordTdsReversal` owns the tax leg separately, and clawing back the gross
 * share would recover the withheld tax the platform never disbursed — that
 * money belongs to the government, not to us.
 *
 * `ConsultantPayout.clawbackAmountPaise` / `.clawbackInitiatedAt` are the
 * counter, mirroring `OrganizationPayout`, and the increment below is what
 * keeps them in step with the journal — the same discipline as
 * `reversePayoutClawback`. Without the pair the outstanding recovery would be
 * observable only as a ledger balance, with no counter for the reconciler's
 * dual-write check to compare the journal against.
 */
async function reverseConsultantPayoutClawback(
  tx: Tx,
  input: ApplyReversalInput,
  consultantPayoutId: string,
  consultantProfileId: string,
): Promise<boolean> {
  if (input.amountPaise <= 0) return false;

  // Idempotency is asserted here, not merely inherited from `postLedgerTxn`'s
  // unique key: a driver may present several earnings against one payout for a
  // single dispute, and this is the one place that can tell a first, genuine
  // clawback from a replay of the same (dispute, payout) pair.
  const alreadyPosted = await tx.ledgerTransaction.findUnique({
    where: {
      idempotencyKey: consultantClawbackKey(
        input.refundId,
        consultantPayoutId,
      ),
    },
    select: { id: true },
  });
  if (alreadyPosted) return false;

  const payout = await tx.consultantPayout.findUnique({
    where: { id: consultantPayoutId },
    select: { id: true, clawbackInitiatedAt: true },
  });
  if (!payout) {
    reportSentryMessage(
      "reverseConsultantPayoutClawback: target ConsultantPayout not found",
      {
        subsystem: "payments",
        level: "warning",
        extra: { consultantPayoutId, refundId: input.refundId },
      },
    );
    return false;
  }

  // Counter, kept in step with the journal exactly as `reversePayoutClawback`
  // does for the org pair. `clawbackInitiatedAt` is stamped once (`undefined`
  // on a repeat) so it records when recovery of this payout was FIRST owed.
  //
  // Deliberately NOT done: `markConsultantPayoutReversed` already owns the
  // payout's status flip, and flipping it here would re-open the earnings
  // (`PAID → READY`) for a future batch to re-pay money the consultant still
  // holds — paying twice for one reversed share.
  await tx.consultantPayout.update({
    where: { id: consultantPayoutId },
    data: {
      clawbackAmountPaise: { increment: input.amountPaise },
      clawbackInitiatedAt: payout.clawbackInitiatedAt ? undefined : new Date(),
    },
  });

  await postConsultantPayoutClawback(tx, {
    refundId: input.refundId,
    consultantPayoutId,
    consultantProfileId,
    amountPaise: input.amountPaise,
    reason: input.reason,
  });

  return true;
}

/**
 * The clawback journal for a consultant payout: `Dr CONSULTANT_RECEIVABLE
 * / Cr PLATFORM_FEE`, idempotent on `clawback:<refundId>:<payoutId>`. See
 * {@link reverseConsultantPayoutClawback} for why this is a receivable rather
 * than the org rail's `Dr CASH / Cr ORG_PAYABLE`. INR-only, so the ledger
 * account currency is left unset as post.ts documents.
 */
export async function postConsultantPayoutClawback(
  tx: Tx,
  input: {
    refundId: string;
    consultantPayoutId: string;
    consultantProfileId: string;
    amountPaise: number;
    reason: string;
  },
): Promise<void> {
  const { consultantPayoutId, consultantProfileId, amountPaise } = input;
  // The counter-post is part of the reversal, not a side effect: report, then
  // rethrow so the enclosing tx rolls back — an unbalanced journal never commits
  // (#1583 C-P1-09), which is what keeps the earnings reversal and this clawback
  // atomic and therefore agreeing on the amount.
  try {
    await postLedgerTxn(tx, {
      idempotencyKey: consultantClawbackKey(
        input.refundId,
        consultantPayoutId,
      ),
      // `PAYOUT`, not `ORG_PAYOUT`: this counters a `payout:<payoutId>` txn
      // (doc §4.4), and the soft-linked `payoutId` is a ConsultantPayout cuid, so
      // reconcile's `clawback:*` scan over OrganizationPayout ids never sees it.
      kind: "PAYOUT",
      payoutId: consultantPayoutId,
      description: `Consultant payout clawback: ${amountPaise} paise from payout ${consultantPayoutId} (${input.reason})`,
      postings: [
        {
          account: { kind: "CONSULTANT_RECEIVABLE", consultantProfileId },
          direction: "DEBIT",
          amountPaise,
        },
        {
          account: { kind: "PLATFORM_FEE" },
          direction: "CREDIT",
          amountPaise,
        },
      ],
    });
  } catch (err) {
    reportSentryError(err, { subsystem: "payments", level: "fatal" });
    console.error(
      `[ledger] consultant payout clawback posting FAILED for payout ${consultantPayoutId} (refund tx rolls back): ${err instanceof Error ? err.message : String(err)}`,
    );
    void recordSystemErrorSafe({
      // No org to attribute this to — the counterparty is a consultant. The
      // SystemEvent is the consultant rail's only audit-log surface, which is
      // exactly why the caller keeps paging CONSULTANT_PAID_EARNING_CLAWBACK.
      organizationId: null,
      category: "LEDGER",
      summary: `Consultant payout clawback ledger posting failed for payout ${consultantPayoutId}`,
      err,
      context: { consultantPayoutId, consultantProfileId, refundId: input.refundId },
    });
    throw err;
  }
}
