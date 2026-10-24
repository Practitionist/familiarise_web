import type { Tx } from "@/lib/prisma";
import type { AccountRef, Posting } from "@/lib/payments/ledger/post";
import { prorate, sumPaise } from "@/lib/payments/utils/money";

export type OverageCaptureLine = {
  account: AccountRef;
  capturedPaise: number;
  reversedPaise: number;
};

/** The non-GST credits of a member overage capture, with what earlier refunds already debited back. */
export async function overageCaptureCredits(
  tx: Tx,
  paymentId: string,
): Promise<OverageCaptureLine[]> {
  const entries = await tx.ledgerEntry.findMany({
    where: {
      account: { kind: { not: "GST_PAYABLE" } },
      transaction: {
        paymentId,
        OR: [{ idempotencyKey: `overage:${paymentId}` }, { kind: "REFUND" }],
      },
    },
    select: {
      accountId: true,
      direction: true,
      amountPaise: true,
      account: { select: { kind: true, organizationId: true } },
      transaction: { select: { kind: true } },
    },
    orderBy: { accountId: "asc" },
  });
  const lines = new Map<string, OverageCaptureLine>();
  for (const e of entries) {
    if (e.transaction.kind === "REFUND" || e.direction !== "CREDIT") continue;
    lines.set(e.accountId, {
      account: {
        kind: e.account.kind,
        organizationId: e.account.organizationId,
      },
      capturedPaise: sumPaise(e.amountPaise),
      reversedPaise: 0,
    });
  }
  for (const e of entries) {
    const line = lines.get(e.accountId);
    if (line && e.transaction.kind === "REFUND" && e.direction === "DEBIT") {
      line.reversedPaise += sumPaise(e.amountPaise);
    }
  }
  return [...lines.values()];
}

/** Debits reversing `amountPaise` of the capture pro rata; the completing refund takes each line's remainder. */
export function reverseOverageCapture(
  lines: OverageCaptureLine[],
  amountPaise: number,
  completes: boolean,
): Posting[] {
  const captured = lines.reduce((s, l) => s + l.capturedPaise, 0);
  let left = amountPaise;
  const debits: Posting[] = lines.map((line, i) => {
    const want = completes
      ? line.capturedPaise - line.reversedPaise
      : prorate(line.capturedPaise, amountPaise, Math.max(captured, 1));
    const share =
      i === lines.length - 1 ? left : Math.min(left, Math.max(want, 0));
    left -= share;
    return { account: line.account, direction: "DEBIT", amountPaise: share };
  });
  return debits.filter((d) => d.amountPaise > 0);
}
