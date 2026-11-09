import {
  reportSentryError,
  reportSentryMessage,
} from "@/lib/observability/report";
import type { Tx } from "@/lib/prisma";
import { stageRaisedClawback } from "@/lib/payments/payouts/clawback-notifications";
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
 * re-implementing it.
 *
 * Production callers (#776 §C):
 *   - PAYOUT_CLAWBACK   — the dispute-lost branch of handleDisputeUpdated.
 *   - CONSULTANT_CLAWBACK — the same branch's consultant rail: a lost dispute on
 *                         an earning a COMPLETED ConsultantPayout already paid.
 *   - BOOKING / OVERAGE — single-payment reversals still flow through
 *                         `refundPayment` (it owns the gateway phases); nothing
 *                         calls applyReversal for those from a route.
 */

import { Prisma } from "@prisma/client";
import { applyRefundCascade, type ApplyRefundCascadeResult } from "./refund";
import { postLedgerTxn } from "@/lib/payments/ledger/post";
import { ORG_CLAWBACK_KEY_PREFIX } from "@/lib/payments/payouts/clawback-recovery";
import { recordOrgTdsReversal } from "@/lib/payments/tax/tds-service";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";
import { formatCurrencyAmount } from "@/utils/formatting";
import { recordSystemErrorSafe } from "@/lib/enterprise/system-events";

type ReversalSource =
  // A single booking payment (the common case).
  | { kind: "BOOKING"; paymentId: string }
  // An overage side-charge — itself a Payment (parentPaymentId-linked), so it
  // reverses through the booking cascade on that payment id.
  | { kind: "OVERAGE"; overagePaymentId: string }
  // Clawback of a host org's share already paid out, booked as a receivable.
  | {
      kind: "PAYOUT_CLAWBACK";
      orgPayoutId: string;
      organizationId: string;
      orgEarningsId: string;
    }
  // Consultant mirror of PAYOUT_CLAWBACK, also booked as a receivable.
  | {
      kind: "CONSULTANT_CLAWBACK";
      consultantPayoutId: string;
      consultantProfileId: string;
    };

export interface ApplyReversalInput {
  source: ReversalSource;
  /** Total paise to reverse. */
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
        clawbackPosted: false,
      };
    }

    case "PAYOUT_CLAWBACK": {
      const posted = await reversePayoutClawback(tx, input, input.source);
      return {
        kind: "PAYOUT_CLAWBACK",
        cascades: [],
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

/**
 * Org payout clawback, net of the TDS reversed on the share: no cash comes back,
 * so the debt is a receivable netted from the next payout. Stamps the counter.
 */
async function reversePayoutClawback(
  tx: Tx,
  input: ApplyReversalInput,
  share: { orgPayoutId: string; organizationId: string; orgEarningsId: string },
): Promise<boolean> {
  const { orgPayoutId, organizationId, orgEarningsId } = share;
  if (input.amountPaise <= 0) return false;

  const payout = await tx.organizationPayout.findUnique({
    where: { id: orgPayoutId },
    select: { id: true, clawbackInitiatedAt: true, netPayoutPaise: true },
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

  const clawbackPaise = await orgClawbackNetOfTds(tx, {
    orgPayoutId,
    organizationId,
    grossPaise: input.amountPaise,
    netPayoutPaise: payout.netPayoutPaise,
  });

  await tx.organizationPayout.update({
    where: { id: orgPayoutId },
    data: {
      clawbackAmountPaise: { increment: clawbackPaise },
      clawbackInitiatedAt: payout.clawbackInitiatedAt ? undefined : new Date(),
    },
  });

  await tx.orgAuditLog.create({
    data: {
      organizationId,
      actorMembershipId: null,
      category: "PAYOUT",
      action: AUDIT_ACTIONS.PAYOUT.PAYOUT_CLAWBACK,
      description: `Payout clawback: ${formatCurrencyAmount(clawbackPaise, "INR")} recovered from an organisation payout`,
      details: {
        refundId: input.refundId,
        orgEarningsId,
        orgPayoutId,
        reason: input.reason,
        amountPaise: input.amountPaise,
        clawbackAmountPaise: clawbackPaise,
        initiatedByUserId: input.initiatedByUserId ?? null,
      } as Prisma.InputJsonValue,
    },
  });

  await postPayoutClawback(tx, {
    refundId: input.refundId,
    payoutId: orgPayoutId,
    orgEarningsId,
    amountPaise: clawbackPaise,
    organizationId,
  });

  return true;
}

/**
 * Reverses the TDS the org payout withheld on a reversed share, pro rata to its
 * net, and returns the clawback net of it: the org never received that tax.
 */
export async function orgClawbackNetOfTds(
  tx: Tx,
  input: {
    orgPayoutId: string;
    organizationId: string;
    grossPaise: number;
    netPayoutPaise: number;
    refundId?: string;
  },
): Promise<number> {
  const reversal = await recordOrgTdsReversal(tx, {
    orgPayoutId: input.orgPayoutId,
    organizationId: input.organizationId,
    refundId: input.refundId,
    reversalBasis: {
      kind: "PROPORTIONAL",
      refundAmountPaise: input.grossPaise,
      payoutAmountPaise: input.netPayoutPaise,
    },
  });
  return input.grossPaise - (reversal?.reversedPaise ?? 0);
}

/**
 * Refund-driven clawback of an org share a COMPLETED payout already paid:
 * TDS reversal, counter, audit row and journal in one place for every refund door.
 */
export async function clawBackCompletedOrgPayout(
  tx: Tx,
  input: {
    orgPayout: {
      id: string;
      netPayoutPaise: number;
      clawbackInitiatedAt: Date | null;
    };
    organizationId: string;
    orgEarningsId: string;
    paymentId: string;
    refundId: string;
    /** The org share the refund reversed, gross of TDS. */
    grossPaise: number;
    /** The request behind the reversal, recorded on the audit row. */
    amountPaise: number;
    label: string;
    initiatedByUserId: string | null;
  },
): Promise<void> {
  const { orgPayout, organizationId } = input;
  const clawbackPaise = await orgClawbackNetOfTds(tx, {
    orgPayoutId: orgPayout.id,
    organizationId,
    grossPaise: input.grossPaise,
    netPayoutPaise: orgPayout.netPayoutPaise,
    refundId: input.refundId,
  });
  await tx.organizationPayout.update({
    where: { id: orgPayout.id },
    data: {
      clawbackAmountPaise: { increment: clawbackPaise },
      // The first clawback's timestamp survives later partial refunds.
      clawbackInitiatedAt: orgPayout.clawbackInitiatedAt
        ? undefined
        : new Date(),
    },
  });
  await tx.orgAuditLog.create({
    data: {
      organizationId,
      actorMembershipId: null,
      category: "PAYOUT",
      action: AUDIT_ACTIONS.PAYOUT.PAYOUT_CLAWBACK,
      description: `${input.label}: ${formatCurrencyAmount(clawbackPaise, "INR")} recovered from an organisation payout`,
      details: {
        paymentId: input.paymentId,
        refundId: input.refundId,
        orgEarningsId: input.orgEarningsId,
        orgPayoutId: orgPayout.id,
        amountPaise: input.amountPaise,
        clawbackAmountPaise: clawbackPaise,
        initiatedByUserId: input.initiatedByUserId,
      } as Prisma.InputJsonValue,
    },
  });
  // The counter and the journal are one write: a failed post rolls the tx back.
  await postPayoutClawback(tx, {
    refundId: input.refundId,
    payoutId: orgPayout.id,
    orgEarningsId: input.orgEarningsId,
    amountPaise: clawbackPaise,
    organizationId,
  });
}

/**
 * The org clawback journal `Dr ORG_RECEIVABLE / Cr ORG_PAYABLE`; every writer of
 * `clawbackAmountPaise` posts it, keyed per share so sibling shares on one payout never collide.
 */
export async function postPayoutClawback(
  tx: Tx,
  input: {
    refundId: string;
    payoutId: string;
    /** The reversed share; null for a clawback no single share drives. */
    orgEarningsId: string | null;
    amountPaise: number;
    organizationId: string;
  },
): Promise<void> {
  const { refundId, payoutId, orgEarningsId, amountPaise, organizationId } =
    input;
  // The counter-post is part of the reversal, not a side effect: report, then
  // rethrow so the enclosing tx rolls back — an unbalanced journal never commits (#1583 C-P1-09).
  let posted: Awaited<ReturnType<typeof postLedgerTxn>>;
  try {
    posted = await postLedgerTxn(tx, {
      idempotencyKey: orgClawbackKey(refundId, payoutId, orgEarningsId),
      kind: "ORG_PAYOUT",
      payoutId,
      postings: [
        {
          account: { kind: "ORG_RECEIVABLE", organizationId },
          direction: "DEBIT",
          amountPaise,
        },
        {
          // Reclassifies the debit the refund or chargeback left on the payable.
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
  await stageRaisedClawback(tx, posted, {
    payee: { rail: "ORG", organizationId },
    payoutId,
    amountPaise,
  });
}

/** `clawback:<driver>:<payoutId>[:<orgEarningsId>]`: one org clawback journal per reversed share. */
function orgClawbackKey(
  driver: string,
  payoutId: string,
  orgEarningsId: string | null,
): string {
  const share = orgEarningsId ? `:${orgEarningsId}` : "";
  return `${ORG_CLAWBACK_KEY_PREFIX}${driver}:${payoutId}${share}`;
}

/** One clawback per (driver id, payout); the dispute path passes `dispute:<id>`. */
export function consultantClawbackKey(
  refundId: string,
  consultantPayoutId: string,
): string {
  return `clawback:${refundId}:${consultantPayoutId}`;
}

/**
 * Consultant clawback for a PAID payout (no reverse-transfer on this rail):
 * `Dr CONSULTANT_RECEIVABLE / Cr CONSULTANT_PAYABLE`, net of TDS. A pure
 * reclassification of the debit the chargeback reversal left on the payable.
 */
async function reverseConsultantPayoutClawback(
  tx: Tx,
  input: ApplyReversalInput,
  consultantPayoutId: string,
  consultantProfileId: string,
): Promise<boolean> {
  if (input.amountPaise <= 0) return false;

  // One clawback per (dispute, payout), even when several earnings share it.
  const alreadyPosted = await tx.ledgerTransaction.findUnique({
    where: {
      idempotencyKey: consultantClawbackKey(input.refundId, consultantPayoutId),
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

  // Counter kept in step with the journal. Never flips payout status: that
  // would re-open PAID earnings for a second payout.
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

/** Clawback journal, idempotent on `clawback:<refundId>:<payoutId>`. */
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
  // Rethrow so the enclosing tx rolls back: reversal and clawback stay atomic.
  let posted: Awaited<ReturnType<typeof postLedgerTxn>>;
  try {
    posted = await postLedgerTxn(tx, {
      idempotencyKey: consultantClawbackKey(input.refundId, consultantPayoutId),
      // Counters a consultant `payout:<id>` txn (doc §4.4), hence PAYOUT.
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
          // The lost-chargeback journal already debited this payable for the
          // reversed share; move that debit balance onto the receivable.
          account: { kind: "CONSULTANT_PAYABLE", consultantProfileId },
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
      // Consultant counterparty: no org to attribute to.
      organizationId: null,
      category: "LEDGER",
      summary: `Consultant payout clawback ledger posting failed for payout ${consultantPayoutId}`,
      err,
      context: {
        consultantPayoutId,
        consultantProfileId,
        refundId: input.refundId,
      },
    });
    throw err;
  }
  await stageRaisedClawback(tx, posted, {
    payee: { rail: "CONSULTANT", consultantProfileId },
    payoutId: consultantPayoutId,
    amountPaise,
  });
}

export {
  accumulatePaidConsultantClawback,
  applyPaidConsultantClawbacks,
  type PendingConsultantClawback,
} from "@/lib/payments/payouts/paid-consultant-clawback";
