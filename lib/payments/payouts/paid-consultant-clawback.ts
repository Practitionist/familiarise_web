import type { Tx } from "@/lib/prisma";
import { recordSystemErrorSafe } from "@/lib/enterprise/system-events";
import { reportSentryError } from "@/lib/observability/report";
import { postLedgerTxn } from "@/lib/payments/ledger/post";

function consultantClawbackKey(
  refundId: string,
  consultantPayoutId: string,
): string {
  return `clawback:${refundId}:${consultantPayoutId}`;
}

export type PendingConsultantClawback = {
  consultantProfileId: string;
  netAmountPaise: number;
  clawbackInitiatedAt: Date | null;
};

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
  try {
    await postLedgerTxn(tx, {
      idempotencyKey: consultantClawbackKey(input.refundId, consultantPayoutId),
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
    await recordSystemErrorSafe({
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
}

/**
 * Accumulate the net post-TDS clawback owed by a consultant on an already-PAID
 * earning row whose payout is COMPLETED.
 *
 * Uses the payout's net fraction `(payoutGross - payoutTds) / payoutGross`
 * because the bank wire only transferred the net amount to the consultant.
 */
export function accumulatePaidConsultantClawback(
  map: Map<string, PendingConsultantClawback>,
  earnings: {
    status: string;
    consultantProfileId: string;
    payoutId: string | null;
    payout?: {
      status?: string | null;
      amount?: number | bigint | null;
      tdsDeducted?: number | bigint | null;
      clawbackInitiatedAt?: Date | null;
    } | null;
  },
  reversedPaise: number,
  options?: { isOrgPayment?: boolean },
): void {
  if (
    options?.isOrgPayment ||
    earnings.status !== "PAID" ||
    !earnings.payoutId ||
    earnings.payout?.status !== "COMPLETED" ||
    reversedPaise <= 0
  ) {
    return;
  }
  const payoutGross = Number(earnings.payout.amount ?? 0);
  const payoutTds = Number(earnings.payout.tdsDeducted ?? 0);
  const netClawbackPaise =
    payoutGross > 0
      ? Math.floor(
          (reversedPaise * Math.max(0, payoutGross - payoutTds)) / payoutGross,
        )
      : reversedPaise;
  if (netClawbackPaise <= 0) return;
  const prev = map.get(earnings.payoutId);
  map.set(earnings.payoutId, {
    consultantProfileId: earnings.consultantProfileId,
    netAmountPaise: (prev?.netAmountPaise ?? 0) + netClawbackPaise,
    clawbackInitiatedAt:
      prev?.clawbackInitiatedAt ?? earnings.payout.clawbackInitiatedAt ?? null,
  });
}

export async function applyPaidConsultantClawbacks(
  tx: Tx,
  map: Map<string, PendingConsultantClawback>,
  input: {
    refundId: string;
    reason: string;
    onApplied?: (
      consultantPayoutId: string,
      claw: PendingConsultantClawback,
    ) => Promise<void>;
  },
): Promise<boolean> {
  let initiated = false;
  for (const [consultantPayoutId, claw] of map) {
    if (claw.netAmountPaise <= 0) continue;
    await tx.consultantPayout?.update?.({
      where: { id: consultantPayoutId },
      data: {
        clawbackAmountPaise: { increment: claw.netAmountPaise },
        clawbackInitiatedAt: claw.clawbackInitiatedAt ? undefined : new Date(),
      },
    });
    await postConsultantPayoutClawback(tx, {
      refundId: input.refundId,
      consultantPayoutId,
      consultantProfileId: claw.consultantProfileId,
      amountPaise: claw.netAmountPaise,
      reason: input.reason,
    });
    if (input.onApplied) {
      await input.onApplied(consultantPayoutId, claw);
    }
    initiated = true;
  }
  return initiated;
}
