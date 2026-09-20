/**
 * #1766 — which earnings tranche a refund claws back from.
 *
 * A subscription's earnings are one row per cycle (`cycleOrdinal`), so a
 * partial refund is no longer a flat proportion of every row: the money comes
 * back out of the sessions that were NOT delivered, which are the newest
 * tranches. The order is (a) undelivered tranches (`holdUntil` NULL), newest
 * first, (b) tranches whose hold is running or released, newest first, then
 * (c) rows already batched into a payout and (d) rows already PAID, so a
 * matured cycle is touched only once the undelivered ones are exhausted. Each
 * row absorbs at most what it still holds (share − already refunded).
 *
 * Pure on purpose: both refund writers (`applyRefundCascade` and
 * `refundEarnings`) call it with the clawback they computed once as
 * `prorate(Σ share, refundNum, refundDen)`, and it is unit-tested with no
 * mocks. Rows with no `cycleOrdinal` are not for this module — the writers
 * keep the per-row proportion for them.
 */

export interface ClawbackRow {
  id: string;
  cycleOrdinal: number | null;
  consultantSharePaise: number;
  refundedShareAmount: number;
  status: string;
  holdUntil: Date | null;
}

export interface ClawbackAllocation {
  id: string;
  absorbPaise: number;
}

function rank(row: ClawbackRow): number {
  if (row.status === "PAID") return 3;
  if (row.status === "BATCHED") return 2;
  return row.holdUntil === null ? 0 : 1;
}

export function allocateCycleClawback(
  rows: ClawbackRow[],
  clawbackPaise: number,
): ClawbackAllocation[] {
  const ordered = rows
    .filter((r) => r.status !== "REFUNDED")
    .sort(
      (a, b) =>
        rank(a) - rank(b) || (b.cycleOrdinal ?? -1) - (a.cycleOrdinal ?? -1),
    );
  const out: ClawbackAllocation[] = [];
  let left = Math.max(0, clawbackPaise);
  for (const row of ordered) {
    if (left <= 0) break;
    const capacity = Math.max(
      0,
      row.consultantSharePaise - row.refundedShareAmount,
    );
    const absorbPaise = Math.min(left, capacity);
    if (absorbPaise <= 0) continue;
    out.push({ id: row.id, absorbPaise });
    left -= absorbPaise;
  }
  return out;
}
