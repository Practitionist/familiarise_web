/**
 * Wallet top-up refunds: booking one gateway refund of a top-up, and walking an
 * org's confirmed top-ups newest first to return its remaining wallet balance
 * the way it came in.
 *
 * A top-up has no `Payment` row, so its refund lives on the journal alone:
 * `topup-refund:<gatewayRefundId>` (Dr WALLET / Cr gateway clearing), the same
 * key the refund webhook books, so whichever arrives second is a no-op.
 */

import { Prisma, type RefundStatus } from "@prisma/client";

import prisma, { type Tx } from "@/lib/prisma";
import { gatewayCashAccount } from "@/lib/payments/ledger/gateway-account";
import { postLedgerTxn } from "@/lib/payments/ledger/post";
import { withSerializableRetry } from "@/lib/db/serializable-retry";
import {
  createRazorpayRefund,
  listRazorpayRefunds,
} from "@/lib/payments/core/razorpay";
import { RefundError } from "@/lib/payments/core/types";
import { reportSentryError } from "@/lib/observability/report";

/**
 * Books one SUCCEEDED gateway refund of a top-up. The wallet floor wins: only
 * what the cache still holds is clawed back, the rest books as ORG_RECEIVABLE.
 */
export async function bookTopUpRefund(
  tx: Tx,
  params: {
    topUp: {
      billingAccountId: string;
      amountPaise: number;
      providerOrderId: string;
    };
    refundId: string;
    amountPaise: number;
  },
): Promise<{ booked: boolean; clawbackPaise: number; shortfallPaise: number }> {
  const { topUp, refundId } = params;
  const refundAmt = Math.min(params.amountPaise, topUp.amountPaise);
  const account = await tx.billingAccount.findUniqueOrThrow({
    where: { id: topUp.billingAccountId },
    select: { walletBalance: true, ownerOrgId: true },
  });
  // Keyed on the gateway refund id: Razorpay allows several partial refunds per payment.
  const posted = await postLedgerTxn(tx, {
    idempotencyKey: `topup-refund:${refundId}`,
    kind: "TOPUP_REFUND",
    description: `Refund for top-up ${topUp.providerOrderId} (gateway refund ${refundId})`,
    postings: [
      {
        account: { kind: "WALLET", organizationId: account.ownerOrgId },
        direction: "DEBIT",
        amountPaise: refundAmt,
      },
      {
        account: gatewayCashAccount(),
        direction: "CREDIT",
        amountPaise: refundAmt,
      },
    ],
  });
  if (!posted.created) {
    return { booked: false, clawbackPaise: 0, shortfallPaise: 0 };
  }

  const desiredClawbackPaise = Math.min(
    Math.max(Number(account.walletBalance ?? 0), 0),
    refundAmt,
  );
  // Conditional decrement: a balance that moved below the snapshot books as shortfall.
  let clawbackPaise = desiredClawbackPaise;
  if (desiredClawbackPaise > 0) {
    const decremented = await tx.billingAccount.updateMany({
      where: {
        id: topUp.billingAccountId,
        walletBalance: { gte: desiredClawbackPaise },
      },
      data: { walletBalance: { decrement: desiredClawbackPaise } },
    });
    if (decremented.count === 0) clawbackPaise = 0;
  }
  const shortfallPaise = refundAmt - clawbackPaise;
  if (shortfallPaise > 0) {
    await postLedgerTxn(tx, {
      idempotencyKey: `topup-refund-shortfall:${refundId}`,
      kind: "TOPUP_REFUND",
      description:
        "Top-up refunded after the credited funds were spent — unrecovered portion receivable from the org",
      postings: [
        {
          account: {
            kind: "ORG_RECEIVABLE",
            organizationId: account.ownerOrgId,
          },
          direction: "DEBIT",
          amountPaise: shortfallPaise,
        },
        {
          account: { kind: "WALLET", organizationId: account.ownerOrgId },
          direction: "CREDIT",
          amountPaise: shortfallPaise,
        },
      ],
    });
  }
  return { booked: true, clawbackPaise, shortfallPaise };
}

/** The refund-remaining door's dedupe key for one top-up. */
export const walletRefundKey = (billingAccountId: string, topUpId: string) =>
  `wallet-refund:${billingAccountId}:${topUpId}`;

export interface WalletRefundLine {
  topUpId: string;
  providerPaymentId: string;
  refundId: string;
  amountPaise: number;
  status: RefundStatus;
  /** True when this run found the refund already at the gateway under its dedupe key. */
  reused: boolean;
}

export interface RefundRemainingResult {
  startingBalancePaise: number;
  /** Cached balance after every SUCCEEDED refund this run booked. */
  balanceAfterPaise: number;
  /** Refunds still PENDING at the gateway; the refund webhook books them. */
  pendingPaise: number;
  refunds: WalletRefundLine[];
  /** The top-up whose gateway call failed and stopped the walk, if any. */
  stoppedOn: { topUpId: string; code: string } | null;
}

async function bookIfSucceeded(
  line: WalletRefundLine,
  topUp: {
    billingAccountId: string;
    amountPaise: number;
    providerOrderId: string;
  },
): Promise<void> {
  if (line.status !== "SUCCEEDED") return;
  await withSerializableRetry(() =>
    prisma.$transaction(
      (tx) =>
        bookTopUpRefund(tx, {
          topUp,
          refundId: line.refundId,
          amountPaise: line.amountPaise,
        }),
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}

async function cachedBalance(billingAccountId: string): Promise<number> {
  const acct = await prisma.billingAccount.findUniqueOrThrow({
    where: { id: billingAccountId },
    select: { walletBalance: true },
  });
  return Number(acct.walletBalance ?? 0);
}

/**
 * Refunds `min(remaining, top-up refundable)` against each CONFIRMED top-up,
 * newest first, until the balance is spoken for. A gateway refund already
 * carrying this top-up's dedupe key is reused, never repeated; the walk stops
 * at the first gateway failure. Callers freeze wallet spend around it.
 */
export async function refundRemainingWalletBalance(params: {
  billingAccountId: string;
  reason: string;
}): Promise<RefundRemainingResult> {
  const { billingAccountId } = params;
  const startingBalancePaise = await cachedBalance(billingAccountId);
  const topUps = await prisma.walletTopUp.findMany({
    where: {
      billingAccountId,
      status: "CONFIRMED",
      providerPaymentId: { not: null },
    },
    orderBy: [{ confirmedAt: "desc" }, { createdAt: "desc" }],
    select: {
      id: true,
      billingAccountId: true,
      amountPaise: true,
      providerOrderId: true,
      providerPaymentId: true,
    },
  });

  const refunds: WalletRefundLine[] = [];
  let pendingPaise = 0;
  let stoppedOn: RefundRemainingResult["stoppedOn"] = null;

  for (const topUp of topUps) {
    const balancePaise = await cachedBalance(billingAccountId);
    if (balancePaise - pendingPaise <= 0) break;
    const providerPaymentId = topUp.providerPaymentId;
    if (!providerPaymentId) continue;
    const dedupeKey = walletRefundKey(billingAccountId, topUp.id);
    try {
      const existing = await listRazorpayRefunds(providerPaymentId, 100);
      const prior = existing.find(
        (r) => r.metadata?.walletRefundKey === dedupeKey,
      );
      // Another refund still in flight on this payment will debit the wallet when it lands.
      pendingPaise += existing
        .filter((r) => r !== prior && r.status === "PENDING")
        .reduce((sum, r) => sum + r.amount, 0);
      let line: WalletRefundLine;
      if (prior) {
        line = {
          topUpId: topUp.id,
          providerPaymentId,
          refundId: prior.refundId,
          amountPaise: prior.amount,
          status: prior.status,
          reused: true,
        };
      } else {
        const refundedPaise = existing
          .filter((r) => r.status === "SUCCEEDED" || r.status === "PENDING")
          .reduce((sum, r) => sum + r.amount, 0);
        const amountPaise = Math.min(
          balancePaise - pendingPaise,
          topUp.amountPaise - refundedPaise,
        );
        if (amountPaise <= 0) continue;
        const created = await createRazorpayRefund({
          paymentIntentId: providerPaymentId,
          amount: amountPaise,
          reason: params.reason,
          metadata: { walletRefundKey: dedupeKey },
          // Razorpay keys allow no colons; the top-up id alone fixes the account.
          idempotencyKey: `wallet-refund_${topUp.id}`,
        });
        line = {
          topUpId: topUp.id,
          providerPaymentId,
          refundId: created.refundId,
          amountPaise: created.amount,
          status: created.status,
          reused: false,
        };
      }
      await bookIfSucceeded(line, topUp);
      if (line.status === "PENDING") pendingPaise += line.amountPaise;
      refunds.push(line);
    } catch (error) {
      // Gateway calls report their own RefundError; the walk stops, so this fires once per run.
      if (!(error instanceof RefundError)) {
        reportSentryError(error, {
          subsystem: "payments",
          op: "wallet-refund-remaining",
          extra: { billingAccountId, topUpId: topUp.id },
        });
      }
      stoppedOn = {
        topUpId: topUp.id,
        code: error instanceof RefundError ? error.code : "REFUND_STEP_FAILED",
      };
      break;
    }
  }

  return {
    startingBalancePaise,
    balanceAfterPaise: await cachedBalance(billingAccountId),
    pendingPaise,
    refunds,
    stoppedOn,
  };
}
