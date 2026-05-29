/**
 * Wallet balance helpers. The wallet is a prepaid liability we owe an org,
 * cached on `BillingAccount.walletBalance` and authoritatively recorded in
 * the double-entry journal (the org's WALLET LedgerAccount). #772 B3 removed
 * the old per-row WalletEntry log; balance movements ARE journal postings.
 *
 * Atomicity: the `walletDebit` helper uses a raw SQL
 *   `UPDATE ... WHERE walletBalance >= :amount`
 * conditional update to prevent overdraft under concurrent transactions —
 * the same pattern the old seat-helpers.ts used for acquireSeat.
 *
 * Top-up flow (Razorpay-only for v1):
 *   1. API calls `initiateTopUp` → a PENDING WalletTopUp keyed by
 *      providerOrderId (@unique). Returns the Razorpay order id to client.
 *   2. Client completes Razorpay checkout.
 *   3. Webhook calls `confirmTopUp(providerOrderId, providerPaymentId)`.
 *   4. `confirmTopUp` atomically: flips the WalletTopUp PENDING → CONFIRMED
 *      (idempotent claim), bumps walletBalance, and posts the top-up's
 *      double-entry txn (Dr CASH / Cr WALLET) — all in one transaction.
 *
 * Booking debit flow (at checkout):
 *   1. `walletDebit` atomically decrements the cached balance.
 *   2. Throws `WalletInsufficientFundsError` if balance would go negative.
 *   3. The accounting leg (Dr WALLET) posts from the settlement layer where
 *      the full fee/payable split is known (createEarningsFromPayment).
 */

import type { Prisma, PrismaClient, WalletReason } from "@prisma/client";

import prisma from "@/lib/prisma";
import { postLedgerTxn } from "@/lib/payments/ledger/post";

export class WalletInsufficientFundsError extends Error {
  constructor(
    public billingAccountId: string,
    public requestedPaise: number,
  ) {
    super(
      `Insufficient wallet balance on billing account ${billingAccountId}: requested ${requestedPaise} paise`,
    );
    this.name = "WalletInsufficientFundsError";
  }
}

/**
 * Atomically debit a wallet. Throws WalletInsufficientFundsError if the
 * account would go negative. Must be called inside a Prisma transaction.
 */
export async function walletDebit(
  tx: Prisma.TransactionClient,
  params: {
    billingAccountId: string;
    amountPaise: number;
    reason: WalletReason;
    paymentId?: string;
    membershipId?: string;
    notes?: string;
  },
): Promise<{ balanceAfter: number }> {
  if (params.amountPaise <= 0) {
    throw new Error(`walletDebit requires positive amountPaise, got ${params.amountPaise}`);
  }
  // Conditional UPDATE: only succeeds when balance is sufficient.
  const updated = await tx.$executeRaw`
    UPDATE "BillingAccount"
    SET "walletBalance" = "walletBalance" - ${params.amountPaise}
    WHERE "id" = ${params.billingAccountId}
      AND "walletBalance" IS NOT NULL
      AND "walletBalance" >= ${params.amountPaise}
  `;
  if (updated === 0) {
    throw new WalletInsufficientFundsError(params.billingAccountId, params.amountPaise);
  }
  const acct = await tx.billingAccount.findUniqueOrThrow({
    where: { id: params.billingAccountId },
    select: { walletBalance: true, currency: true },
  });
  const balanceAfter = acct.walletBalance ?? 0;

  // #772 B3 — WalletEntry removed. The wallet-balance cache is decremented
  // above; the booking-debit's accounting leg (Dr WALLET) posts to the
  // double-entry journal from the settlement layer (createEarningsFromPayment),
  // which is also the wallet-history record.
  return { balanceAfter };
}

/**
 * Credit a wallet (top-up or refund). Same transaction semantics as debit.
 */
export async function walletCredit(
  tx: Prisma.TransactionClient,
  params: {
    billingAccountId: string;
    amountPaise: number;
    reason: WalletReason;
    paymentId?: string;
    membershipId?: string;
    notes?: string;
    providerOrderId?: string;
    providerPaymentId?: string;
  },
): Promise<{ balanceAfter: number }> {
  if (params.amountPaise <= 0) {
    throw new Error(`walletCredit requires positive amountPaise, got ${params.amountPaise}`);
  }
  const updated = await tx.$executeRaw`
    UPDATE "BillingAccount"
    SET "walletBalance" = COALESCE("walletBalance", 0) + ${params.amountPaise}
    WHERE "id" = ${params.billingAccountId}
  `;
  if (updated === 0) {
    throw new Error(`BillingAccount ${params.billingAccountId} not found`);
  }
  const acct = await tx.billingAccount.findUniqueOrThrow({
    where: { id: params.billingAccountId },
    select: { walletBalance: true, currency: true, ownerOrgId: true },
  });
  const balanceAfter = acct.walletBalance ?? 0;

  // #771 D1/D5 / #772 B3 — double-entry is now the sole record (WalletEntry
  // removed). A top-up is a complete 2-leg txn:
  // platform CASH rises and we now owe the org a WALLET balance.
  //   Dr CASH(platform)   Cr WALLET(org)
  // Booking-debit and refund WALLET legs post from the settlement / refund
  // layer (where the full split is known), not here.
  if (params.reason === "TOPUP") {
    await postLedgerTxn(tx, {
      idempotencyKey: `topup:${params.providerOrderId ?? params.paymentId ?? `${params.billingAccountId}:${balanceAfter}`}`,
      kind: "TOPUP",
      paymentId: params.paymentId ?? null,
      postings: [
        {
          account: { kind: "CASH", currency: acct.currency },
          direction: "DEBIT",
          amountPaise: params.amountPaise,
        },
        {
          account: {
            kind: "WALLET",
            organizationId: acct.ownerOrgId,
            currency: acct.currency,
          },
          direction: "CREDIT",
          amountPaise: params.amountPaise,
        },
      ],
    });
  }

  return { balanceAfter };
}

/**
 * Initiate a top-up: creates a PENDING WalletTopUp keyed by providerOrderId
 * so the webhook can idempotently confirm.
 *
 * The `@unique` constraint on WalletTopUp.providerOrderId provides the
 * idempotency guarantee — a second POST with the same order id fails fast.
 * Unlike the old WalletEntry placeholder, the amount is stored up front so
 * confirmTopUp can assert the webhook amount matches what was authorized.
 */
export async function initiateTopUp(
  db: Prisma.TransactionClient | typeof prisma,
  params: {
    billingAccountId: string;
    amountPaise: number;
    providerOrderId: string;
    notes?: string;
  },
): Promise<void> {
  await db.walletTopUp.create({
    data: {
      billingAccountId: params.billingAccountId,
      amountPaise: params.amountPaise,
      providerOrderId: params.providerOrderId,
      status: "PENDING",
      notes: params.notes ?? "Top-up initiated; awaiting webhook",
    },
  });
}

/**
 * Confirm a top-up from a webhook. Idempotent: if the same providerOrderId
 * is confirmed twice, the second call is a no-op.
 */
export async function confirmTopUp(
  prisma: PrismaClient,
  params: {
    providerOrderId: string;
    providerPaymentId: string;
    amountPaise: number;
  },
): Promise<{ confirmed: boolean; balanceAfter?: number }> {
  return prisma.$transaction(async (tx) => {
    // Atomic idempotent claim: flip PENDING → CONFIRMED in a single
    // conditional updateMany. Exactly one racing webhook delivery sees
    // count===1 and proceeds to credit the wallet; a redelivery (or the
    // losing race) sees count===0 and falls through to the no-op branch.
    const claim = await tx.walletTopUp.updateMany({
      where: { providerOrderId: params.providerOrderId, status: "PENDING" },
      data: {
        status: "CONFIRMED",
        providerPaymentId: params.providerPaymentId,
        confirmedAt: new Date(),
      },
    });

    if (claim.count === 0) {
      // Already confirmed by a prior delivery, or no such top-up. Return
      // the current wallet balance so the caller can surface latest state;
      // throw only if the top-up genuinely never existed.
      const existing = await tx.walletTopUp.findUnique({
        where: { providerOrderId: params.providerOrderId },
        select: { billingAccountId: true },
      });
      if (!existing) {
        throw new Error(
          `No WalletTopUp for providerOrderId=${params.providerOrderId}`,
        );
      }
      const ba = await tx.billingAccount.findUniqueOrThrow({
        where: { id: existing.billingAccountId },
        select: { walletBalance: true },
      });
      return { confirmed: false, balanceAfter: ba.walletBalance ?? 0 };
    }

    const topUp = await tx.walletTopUp.findUniqueOrThrow({
      where: { providerOrderId: params.providerOrderId },
      select: { billingAccountId: true },
    });
    const result = await walletCredit(tx, {
      billingAccountId: topUp.billingAccountId,
      amountPaise: params.amountPaise,
      reason: "TOPUP",
      providerOrderId: params.providerOrderId,
      providerPaymentId: params.providerPaymentId,
      notes: `Top-up confirmed via webhook; order=${params.providerOrderId}`,
    });
    return { confirmed: true, balanceAfter: result.balanceAfter };
  });
}
