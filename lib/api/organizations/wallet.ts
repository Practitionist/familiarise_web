/**
 * WalletEntry helpers — replaces the old OrgCreditPool/OrgCreditLedger/
 * OrgCreditPurchase trio with a single immutable ledger on BillingAccount.
 *
 * Atomicity: the `walletDebit` helper uses a raw SQL
 *   `UPDATE ... WHERE walletBalance >= :amount`
 * conditional update to prevent overdraft under concurrent transactions —
 * the same pattern the old seat-helpers.ts used for acquireSeat.
 *
 * Ledger invariant: every WalletEntry row is immutable; the corresponding
 * FundingLedgerEntry is written in the same transaction for audit.
 *
 * Top-up flow (Razorpay-only for v1):
 *   1. API creates WalletEntry with deltaPaise=0 (stub placeholder) and
 *      providerOrderId set. Returns Razorpay order id to client.
 *   2. Client completes Razorpay checkout.
 *   3. Webhook calls `confirmTopUp(providerOrderId, providerPaymentId)`.
 *   4. `confirmTopUp` atomically:
 *        a. Locates the WalletEntry by providerOrderId.
 *        b. UPDATE BillingAccount SET walletBalance += creditsPaise
 *           WHERE id = ... AND walletBalance IS NOT NULL.
 *        c. Writes the real WalletEntry + FundingLedgerEntry.
 *      All within a single Prisma transaction.
 *
 * Booking debit flow (at checkout):
 *   1. `walletDebit` atomically decrements wallet balance and writes
 *      the debit WalletEntry + FundingLedgerEntry.
 *   2. Throws `WalletInsufficientFundsError` if balance would go negative.
 */

import type { Prisma, PrismaClient, WalletReason } from "@prisma/client";

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
    select: { walletBalance: true },
  });
  const balanceAfter = acct.walletBalance ?? 0;

  await tx.walletEntry.create({
    data: {
      billingAccountId: params.billingAccountId,
      deltaPaise: -params.amountPaise,
      reason: params.reason,
      balanceAfter,
      paymentId: params.paymentId,
      membershipId: params.membershipId,
      notes: params.notes,
    },
  });

  await tx.fundingLedgerEntry.create({
    data: {
      billingAccountId: params.billingAccountId,
      deltaPaise: -params.amountPaise,
      reason:
        params.reason === "BOOKING"
          ? "BOOKING_DEBIT"
          : params.reason === "REFUND"
            ? "REFUND_CREDIT"
            : params.reason === "TOPUP"
              ? "TOPUP"
              : "ADJUSTMENT",
      balanceAfterPaise: balanceAfter,
      paymentId: params.paymentId,
      notes: params.notes,
    },
  });

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
    select: { walletBalance: true },
  });
  const balanceAfter = acct.walletBalance ?? 0;

  await tx.walletEntry.create({
    data: {
      billingAccountId: params.billingAccountId,
      deltaPaise: params.amountPaise,
      reason: params.reason,
      balanceAfter,
      paymentId: params.paymentId,
      membershipId: params.membershipId,
      notes: params.notes,
      providerOrderId: params.providerOrderId,
      providerPaymentId: params.providerPaymentId,
    },
  });

  await tx.fundingLedgerEntry.create({
    data: {
      billingAccountId: params.billingAccountId,
      deltaPaise: params.amountPaise,
      reason:
        params.reason === "TOPUP"
          ? "TOPUP"
          : params.reason === "REFUND"
            ? "REFUND_CREDIT"
            : "ADJUSTMENT",
      balanceAfterPaise: balanceAfter,
      paymentId: params.paymentId,
      notes: params.notes,
    },
  });

  return { balanceAfter };
}

/**
 * Initiate a top-up: creates a PENDING WalletEntry keyed by
 * providerOrderId so the webhook can idempotently confirm.
 *
 * The `@unique` constraint on WalletEntry.providerOrderId provides the
 * idempotency guarantee — a second POST with the same order id fails fast.
 */
export async function initiateTopUp(
  prisma: PrismaClient,
  params: {
    billingAccountId: string;
    amountPaise: number;
    providerOrderId: string;
    notes?: string;
  },
): Promise<void> {
  await prisma.walletEntry.create({
    data: {
      billingAccountId: params.billingAccountId,
      deltaPaise: 0, // placeholder until webhook confirms
      reason: "TOPUP",
      balanceAfter: 0, // placeholder
      providerOrderId: params.providerOrderId,
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
    // Atomic claim: DELETE the pending placeholder only if it is still
    // pending (deltaPaise=0). RETURNING hands back the billingAccountId
    // for the subsequent credit write without a separate SELECT. If two
    // webhook deliveries race, exactly one DELETE wins; the loser sees
    // zero rows and falls through to the idempotent "already confirmed"
    // branch below. We also free the unique `providerOrderId` slot so
    // walletCredit can claim it for the confirmed row.
    const claimed = await tx.$queryRaw<Array<{ billingAccountId: string }>>`
      DELETE FROM "WalletEntry"
      WHERE "providerOrderId" = ${params.providerOrderId}
        AND "deltaPaise" = 0
      RETURNING "billingAccountId"
    `;

    if (claimed.length === 0) {
      // Either the placeholder was already claimed by a prior retry (the
      // confirmed row now holds providerOrderId) or no placeholder ever
      // existed. Return the confirmed entry's balanceAfter so the caller
      // can surface the latest state; throw only if neither row exists.
      const confirmed = await tx.walletEntry.findUnique({
        where: { providerOrderId: params.providerOrderId },
        select: { balanceAfter: true },
      });
      if (!confirmed) {
        throw new Error(
          `No WalletEntry for providerOrderId=${params.providerOrderId}`,
        );
      }
      return { confirmed: false, balanceAfter: confirmed.balanceAfter };
    }

    const result = await walletCredit(tx, {
      billingAccountId: claimed[0].billingAccountId,
      amountPaise: params.amountPaise,
      reason: "TOPUP",
      providerOrderId: params.providerOrderId,
      providerPaymentId: params.providerPaymentId,
      notes: `Top-up confirmed via webhook; order=${params.providerOrderId}`,
    });
    return { confirmed: true, balanceAfter: result.balanceAfter };
  });
}
