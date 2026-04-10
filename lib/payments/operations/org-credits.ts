/**
 * SEAT_PACK credit operations for org billing.
 *
 * Credits are stored in paise (1 credit unit = 1 paise) in OrgCreditPool.
 * Every mutation writes an immutable OrgCreditLedger row, maintaining a
 * running balance for audit.
 *
 * Usage:
 *   - `deductCredits()` → called from `handleCheckout` when billingMode === SEAT_PACK
 *   - `creditRefund()` → called from the refund handler (Phase M) to reverse a deduction
 *   - `purchaseCredits()` → called from the gateway webhook after the org owner pays for a credit pack
 */

import { Prisma } from "@prisma/client";

type TxClient = Prisma.TransactionClient;

/**
 * Deduct credits from the org pool. Throws if insufficient balance.
 *
 * Must be called inside a Prisma interactive transaction to guarantee
 * atomicity with the Payment creation in `handleCheckout`.
 *
 * @returns The OrgCreditLedger row (for audit).
 */
export async function deductCredits(
  tx: TxClient,
  organizationProfileId: string,
  amountPaise: number,
  paymentId?: string,
  memberProfileId?: string,
): Promise<{ balanceAfter: number }> {
  if (amountPaise <= 0) throw new Error("Deduction amount must be positive");

  const pool = await tx.orgCreditPool.findUnique({
    where: { organizationProfileId },
  });
  if (!pool) throw new Error("Credit pool not found for this organization");
  if (pool.balance < amountPaise) {
    throw new Error(
      `Insufficient credits: need ${amountPaise} paise but pool has ${pool.balance}`,
    );
  }

  const newBalance = pool.balance - amountPaise;

  await tx.orgCreditPool.update({
    where: { organizationProfileId },
    data: { balance: newBalance },
  });

  const ledger = await tx.orgCreditLedger.create({
    data: {
      organizationProfileId,
      delta: -amountPaise,
      reason: "booking",
      paymentId: paymentId ?? null,
      memberProfileId: memberProfileId ?? null,
      balanceAfter: newBalance,
    },
  });

  return { balanceAfter: ledger.balanceAfter };
}

/**
 * Refund credits back to the org pool (reverses a prior deduction).
 */
export async function creditRefund(
  tx: TxClient,
  organizationProfileId: string,
  amountPaise: number,
  paymentId?: string,
): Promise<{ balanceAfter: number }> {
  if (amountPaise <= 0) throw new Error("Refund amount must be positive");

  const pool = await tx.orgCreditPool.findUnique({
    where: { organizationProfileId },
  });
  if (!pool) throw new Error("Credit pool not found for this organization");

  const newBalance = pool.balance + amountPaise;

  await tx.orgCreditPool.update({
    where: { organizationProfileId },
    data: { balance: newBalance },
  });

  await tx.orgCreditLedger.create({
    data: {
      organizationProfileId,
      delta: amountPaise,
      reason: "refund",
      paymentId: paymentId ?? null,
      balanceAfter: newBalance,
    },
  });

  return { balanceAfter: newBalance };
}

/**
 * Grant purchased credits to the org pool (called after gateway webhook
 * confirms the credit-pack payment).
 */
export async function purchaseCredits(
  tx: TxClient,
  organizationProfileId: string,
  creditsPaise: number,
  paymentId?: string,
): Promise<{ balanceAfter: number }> {
  if (creditsPaise <= 0) throw new Error("Purchase amount must be positive");

  const pool = await tx.orgCreditPool.findUnique({
    where: { organizationProfileId },
  });
  if (!pool) throw new Error("Credit pool not found for this organization");

  const newBalance = pool.balance + creditsPaise;

  await tx.orgCreditPool.update({
    where: { organizationProfileId },
    data: {
      balance: newBalance,
      totalPurchased: { increment: creditsPaise },
    },
  });

  await tx.orgCreditLedger.create({
    data: {
      organizationProfileId,
      delta: creditsPaise,
      reason: "purchase",
      paymentId: paymentId ?? null,
      balanceAfter: newBalance,
    },
  });

  return { balanceAfter: newBalance };
}
