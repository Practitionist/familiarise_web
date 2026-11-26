import { EarningStatus } from "@prisma/client";

import type { Tx } from "@/lib/prisma";
import { releaseClawbackRecovery } from "./clawback-recovery";

const OPEN_PAYOUT_STATUSES = ["PENDING", "APPROVED"] as const;

/**
 * Cancels every PENDING or APPROVED payout that batched one of the payment's
 * earnings, so a hold can freeze them. Only a payout this CAS cancelled hands
 * its earnings back to READY; a PROCESSING payout is left untouched.
 */
export async function cancelOpenPayoutsForPayment(
  tx: Tx,
  paymentId: string,
  failureReason: string,
): Promise<{ consultant: string[]; org: string[] }> {
  return cancelOpenPayoutsForPayments(tx, [paymentId], failureReason);
}

/** The same cancel over many payments in one pass, for a door that gates a whole roster. */
export async function cancelOpenPayoutsForPayments(
  tx: Tx,
  paymentIds: readonly string[],
  failureReason: string,
): Promise<{ consultant: string[]; org: string[] }> {
  if (paymentIds.length === 0) return { consultant: [], org: [] };
  const ofPayments = { paymentId: { in: [...paymentIds] } };
  const consultantPayoutIds = [
    ...new Set(
      (
        await tx.consultantEarnings.findMany({
          where: {
            ...ofPayments,
            status: EarningStatus.BATCHED,
            payout: { status: { in: [...OPEN_PAYOUT_STATUSES] } },
          },
          select: { payoutId: true },
        })
      )
        .map((r) => r.payoutId)
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  const consultant: string[] = [];
  for (const id of consultantPayoutIds) {
    const { count } = await tx.consultantPayout.updateMany({
      where: { id, status: { in: [...OPEN_PAYOUT_STATUSES] } },
      data: { status: "CANCELLED", failureReason },
    });
    if (count === 1) consultant.push(id);
  }
  if (consultant.length > 0) {
    await tx.consultantEarnings.updateMany({
      where: { payoutId: { in: consultant }, status: EarningStatus.BATCHED },
      data: { status: EarningStatus.READY, payoutId: null },
    });
    for (const id of consultant) await releaseClawbackRecovery(tx, id);
  }

  const orgPayoutIds = [
    ...new Set(
      (
        await tx.organizationEarnings.findMany({
          where: {
            ...ofPayments,
            status: EarningStatus.BATCHED,
            orgPayout: { status: { in: [...OPEN_PAYOUT_STATUSES] } },
          },
          select: { orgPayoutId: true },
        })
      )
        .map((r) => r.orgPayoutId)
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  const org: string[] = [];
  for (const id of orgPayoutIds) {
    const { count } = await tx.organizationPayout.updateMany({
      where: { id, status: { in: [...OPEN_PAYOUT_STATUSES] } },
      data: { status: "CANCELLED", failureReason },
    });
    if (count === 1) org.push(id);
  }
  if (org.length > 0) {
    await tx.organizationEarnings.updateMany({
      where: { orgPayoutId: { in: org }, status: EarningStatus.BATCHED },
      data: { status: EarningStatus.READY, orgPayoutId: null },
    });
    for (const id of org) await releaseClawbackRecovery(tx, id);
  }
  return { consultant, org };
}
