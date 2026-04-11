/**
 * SEAT_PACK credit operations for org billing.
 *
 * Credits are stored in paise (1 credit unit = 1 paise) in OrgCreditPool.
 * Every mutation writes an immutable OrgCreditLedger row, maintaining a
 * running balance for audit.
 *
 * All balance mutations use Prisma's atomic `increment`/`decrement` operators
 * to prevent read-then-write races under concurrent transactions.
 */

import { Prisma } from "@prisma/client";

type TxClient = Prisma.TransactionClient;

/**
 * Deduct credits from the org pool. Uses a conditional raw SQL UPDATE to
 * prevent overdraft under concurrency — same pattern as acquireSeat().
 */
export async function deductCredits(
  tx: TxClient,
  organizationProfileId: string,
  amountPaise: number,
  paymentId?: string,
  memberProfileId?: string,
): Promise<{ balanceAfter: number }> {
  if (amountPaise <= 0) throw new Error("Deduction amount must be positive");

  // Atomic conditional decrement — only succeeds if balance >= amountPaise.
  const rows: number = await tx.$executeRaw`
    UPDATE "OrgCreditPool"
    SET balance = balance - ${amountPaise}, "updatedAt" = NOW()
    WHERE "organizationProfileId" = ${organizationProfileId}
      AND balance >= ${amountPaise}
  `;
  if (rows === 0) {
    throw new Error(
      `Insufficient credits: need ${amountPaise} paise`,
    );
  }

  // Read back the updated balance for the ledger row.
  const pool = await tx.orgCreditPool.findUnique({
    where: { organizationProfileId },
    select: { balance: true },
  });
  const balanceAfter = pool?.balance ?? 0;

  await tx.orgCreditLedger.create({
    data: {
      organizationProfileId,
      delta: -amountPaise,
      reason: "booking",
      paymentId: paymentId ?? null,
      memberProfileId: memberProfileId ?? null,
      balanceAfter,
    },
  });

  return { balanceAfter };
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

  // Atomic increment — no race possible.
  const updated = await tx.orgCreditPool.update({
    where: { organizationProfileId },
    data: { balance: { increment: amountPaise } },
    select: { balance: true },
  });

  await tx.orgCreditLedger.create({
    data: {
      organizationProfileId,
      delta: amountPaise,
      reason: "refund",
      paymentId: paymentId ?? null,
      balanceAfter: updated.balance,
    },
  });

  return { balanceAfter: updated.balance };
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

  // Atomic increment — no race possible.
  const updated = await tx.orgCreditPool.update({
    where: { organizationProfileId },
    data: {
      balance: { increment: creditsPaise },
      totalPurchased: { increment: creditsPaise },
    },
    select: { balance: true },
  });

  await tx.orgCreditLedger.create({
    data: {
      organizationProfileId,
      delta: creditsPaise,
      reason: "purchase",
      paymentId: paymentId ?? null,
      balanceAfter: updated.balance,
    },
  });

  return { balanceAfter: updated.balance };
}
