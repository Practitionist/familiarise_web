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

type RefundableTopUp = {
  id: string;
  billingAccountId: string;
  amountPaise: number;
  providerOrderId: string;
  providerPaymentId: string;
};
type GatewayRefund = Awaited<ReturnType<typeof listRazorpayRefunds>>[number];
type ListedTopUp = {
  topUp: RefundableTopUp;
  existing: GatewayRefund[];
  /** This door's refund for the top-up, found by its dedupe key. */
  prior: GatewayRefund | undefined;
};

const sumAmounts = (rows: GatewayRefund[]) =>
  rows.reduce((sum, r) => sum + r.amount, 0);

/** Where the walk stopped; gateway calls report their own RefundError, anything else reports here, once per run. */
function stoppedAt(
  topUp: RefundableTopUp,
  error: unknown,
): NonNullable<RefundRemainingResult["stoppedOn"]> {
  if (error instanceof RefundError) {
    return { topUpId: topUp.id, code: error.code };
  }
  reportSentryError(error, {
    subsystem: "payments",
    op: "wallet-refund-remaining",
    extra: { billingAccountId: topUp.billingAccountId, topUpId: topUp.id },
  });
  return { topUpId: topUp.id, code: "REFUND_STEP_FAILED" };
}

const lineOf = (
  topUp: RefundableTopUp,
  refund: GatewayRefund,
  reused: boolean,
): WalletRefundLine => ({
  topUpId: topUp.id,
  providerPaymentId: topUp.providerPaymentId,
  refundId: refund.refundId,
  amountPaise: refund.amount,
  status: refund.status,
  reused,
});

/** Issues one new refund of `min(available, top-up refundable)`; null when there is nothing to send. */
async function issueTopUpRefund(
  listed: ListedTopUp,
  availablePaise: number,
  reason: string,
): Promise<WalletRefundLine | null> {
  const { topUp, existing } = listed;
  const refundedPaise = sumAmounts(
    existing.filter((r) => r.status === "SUCCEEDED" || r.status === "PENDING"),
  );
  const amountPaise = Math.min(
    availablePaise,
    topUp.amountPaise - refundedPaise,
  );
  if (amountPaise <= 0) return null;
  const created = await createRazorpayRefund({
    paymentIntentId: topUp.providerPaymentId,
    amount: amountPaise,
    reason,
    metadata: {
      walletRefundKey: walletRefundKey(topUp.billingAccountId, topUp.id),
    },
    // Razorpay keys allow no colons; the top-up id alone fixes the account.
    idempotencyKey: `wallet-refund_${topUp.id}`,
  });
  return lineOf(topUp, created, false);
}

/**
 * Refunds one top-up's whole capture under the refund-remaining door's keys,
 * so the two can never refund the same top-up twice.
 */
export async function refundTopUpCapture(
  topUp: RefundableTopUp,
  reason: string,
): Promise<WalletRefundLine | null> {
  const line = await issueTopUpRefund(
    { topUp, existing: [], prior: undefined },
    topUp.amountPaise,
    reason,
  );
  if (line) await bookIfSucceeded(line, topUp);
  return line;
}

type Stop = NonNullable<RefundRemainingResult["stoppedOn"]>;
type WalkState = {
  billingAccountId: string;
  reason: string;
  /** Gateway refunds still in flight; each debits the wallet when it lands. */
  pendingPaise: number;
  refunds: WalletRefundLine[];
};

/** Every top-up's gateway refunds, read before anything is sized. */
async function listTopUpRefunds(
  topUps: RefundableTopUp[],
): Promise<{ listed: ListedTopUp[]; stoppedOn: Stop | null }> {
  const listed: ListedTopUp[] = [];
  for (const topUp of topUps) {
    try {
      const existing = await listRazorpayRefunds(topUp.providerPaymentId, 100);
      const key = walletRefundKey(topUp.billingAccountId, topUp.id);
      const prior = existing.find((r) => r.metadata?.walletRefundKey === key);
      listed.push({ topUp, existing, prior });
    } catch (error) {
      return { listed, stoppedOn: stoppedAt(topUp, error) };
    }
  }
  return { listed, stoppedOn: null };
}

/** Books this door's earlier refunds, found by their dedupe keys. */
async function bookPriorRefunds(
  listed: ListedTopUp[],
  state: WalkState,
): Promise<Stop | null> {
  for (const l of listed) {
    if (!l.prior) continue;
    const line = lineOf(l.topUp, l.prior, true);
    try {
      await bookIfSucceeded(line, l.topUp);
    } catch (error) {
      return stoppedAt(l.topUp, error);
    }
    state.refunds.push(line);
  }
  return null;
}

/** Issues new refunds newest first while the balance net of in-flight refunds lasts. */
async function issueNewRefunds(
  listed: ListedTopUp[],
  state: WalkState,
): Promise<Stop | null> {
  for (const l of listed) {
    if (l.prior) continue;
    const availablePaise =
      (await cachedBalance(state.billingAccountId)) - state.pendingPaise;
    if (availablePaise <= 0) break;
    try {
      const line = await issueTopUpRefund(l, availablePaise, state.reason);
      if (!line) continue;
      await bookIfSucceeded(line, l.topUp);
      if (line.status === "PENDING") state.pendingPaise += line.amountPaise;
      state.refunds.push(line);
    } catch (error) {
      return stoppedAt(l.topUp, error);
    }
  }
  return null;
}

/**
 * Refunds `min(available, top-up refundable)` against each CONFIRMED top-up,
 * newest first, until the balance is spoken for. Every top-up's gateway
 * refunds are read before any money moves, so a refund still in flight on any
 * of them reserves its share of the balance. A refund already carrying a
 * top-up's dedupe key is reused, never repeated; the walk stops at the first
 * failure. Callers freeze wallet spend around it.
 */
export async function refundRemainingWalletBalance(params: {
  billingAccountId: string;
  reason: string;
}): Promise<RefundRemainingResult> {
  const { billingAccountId } = params;
  const startingBalancePaise = await cachedBalance(billingAccountId);
  const rows = await prisma.walletTopUp.findMany({
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
  const topUps = rows.flatMap((t) =>
    t.providerPaymentId
      ? [{ ...t, providerPaymentId: t.providerPaymentId }]
      : [],
  );

  const state: WalkState = {
    billingAccountId,
    reason: params.reason,
    pendingPaise: 0,
    refunds: [],
  };
  const { listed, stoppedOn: listStop } = await listTopUpRefunds(topUps);
  let stoppedOn = listStop;
  if (!stoppedOn) {
    state.pendingPaise = sumAmounts(
      listed.flatMap((l) => l.existing.filter((r) => r.status === "PENDING")),
    );
    stoppedOn =
      (await bookPriorRefunds(listed, state)) ??
      (await issueNewRefunds(listed, state));
  }
  return {
    startingBalancePaise,
    balanceAfterPaise: await cachedBalance(billingAccountId),
    pendingPaise: state.pendingPaise,
    refunds: state.refunds,
    stoppedOn,
  };
}
