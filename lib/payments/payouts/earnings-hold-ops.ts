/**
 * #1771 K-3 — an operator's hold and release of consultant earnings.
 *
 * Hold: PENDING|READY → HELD. Release: HELD → READY when the hold has
 * matured, else back to PENDING for the release cron; never while the payment
 * has an open refund or dispute (the cascade still has to size itself). Both
 * are one CAS each, the predicates repeated in the WHERE, and a count that
 * falls short rolls the caller's transaction back as a 409.
 */

import { EarningStatus, Prisma, RefundStatus } from "@prisma/client";

import type { Tx } from "@/lib/prisma";
import { OpsRefusal } from "@/lib/backoffice/ops-refusal-error";
import { DISPUTE_INACTIVE_FOR_GATING } from "@/lib/payments/dispute-status";
import { assertEarningStatusTransitionLegal } from "./earning-status";

const HOLDABLE_FROM: EarningStatus[] = [
  EarningStatus.PENDING,
  EarningStatus.READY,
];

/** No refund in flight and no live dispute on the earning's payment. */
export const NO_OPEN_CLAIM: Prisma.ConsultantEarningsWhereInput = {
  payment: {
    refunds: { none: { status: RefundStatus.PENDING, deletedAt: null } },
    disputes: { none: { status: { notIn: DISPUTE_INACTIVE_FOR_GATING } } },
  },
};

type EarningsDb = Pick<Tx, "consultantEarnings">;

function requireReason(reason: string) {
  if (reason.trim().length < 5) {
    throw new OpsRefusal(
      "REASON_REQUIRED",
      "Give a reason for this change.",
      400,
    );
  }
}

async function readRows(db: EarningsDb, ids: string[]) {
  const rows = await db.consultantEarnings.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      status: true,
      holdUntil: true,
      payment: {
        select: {
          refunds: {
            where: { status: RefundStatus.PENDING, deletedAt: null },
            select: { id: true },
          },
          disputes: {
            where: { status: { notIn: DISPUTE_INACTIVE_FOR_GATING } },
            select: { id: true },
          },
        },
      },
    },
  });
  if (rows.length !== new Set(ids).size) {
    throw new OpsRefusal("EARNING_NOT_FOUND", "Earning not found.", 404);
  }
  return rows;
}

const raced = () =>
  new OpsRefusal(
    "EARNING_CHANGED",
    "An earning changed while you were acting on it — reload and try again.",
  );

export async function holdEarnings(
  db: EarningsDb,
  ids: string[],
  reason: string,
): Promise<{ held: number; before: { id: string; status: EarningStatus }[] }> {
  requireReason(reason);
  const rows = await readRows(db, ids);
  const stuck = rows.find((r) => !HOLDABLE_FROM.includes(r.status));
  if (stuck) {
    throw new OpsRefusal(
      "EARNING_NOT_HOLDABLE",
      `Only pending or ready earnings can be held (this one is ${stuck.status}).`,
    );
  }
  for (const r of rows)
    assertEarningStatusTransitionLegal(r.id, r.status, EarningStatus.HELD);
  const moved = await db.consultantEarnings.updateMany({
    where: { id: { in: ids }, status: { in: HOLDABLE_FROM } },
    data: { status: EarningStatus.HELD },
  });
  if (moved.count !== rows.length) throw raced();
  return {
    held: moved.count,
    before: rows.map((r) => ({ id: r.id, status: r.status })),
  };
}

export async function releaseHeldEarnings(
  db: EarningsDb,
  ids: string[],
  reason: string,
  now = new Date(),
): Promise<{ ready: string[]; pending: string[] }> {
  requireReason(reason);
  const rows = await readRows(db, ids);
  if (rows.some((r) => r.status !== EarningStatus.HELD)) {
    throw new OpsRefusal(
      "EARNING_NOT_HELD",
      "Only held earnings can be released.",
    );
  }
  if (
    rows.some((r) => r.payment.refunds.length + r.payment.disputes.length > 0)
  ) {
    throw new OpsRefusal(
      "EARNING_HAS_OPEN_CLAIM",
      "This payment has a refund or dispute still open — release once it settles.",
    );
  }
  const ready = rows
    .filter((r) => r.holdUntil && r.holdUntil <= now)
    .map((r) => r.id);
  const pending = rows.filter((r) => !ready.includes(r.id)).map((r) => r.id);
  let moved = 0;
  if (ready.length > 0) {
    for (const id of ready)
      assertEarningStatusTransitionLegal(
        id,
        EarningStatus.HELD,
        EarningStatus.READY,
      );
    const r = await db.consultantEarnings.updateMany({
      where: {
        id: { in: ready },
        status: EarningStatus.HELD,
        holdUntil: { lte: now },
        ...NO_OPEN_CLAIM,
      },
      data: { status: EarningStatus.READY },
    });
    moved += r.count;
  }
  if (pending.length > 0) {
    const p = await db.consultantEarnings.updateMany({
      where: {
        id: { in: pending },
        status: EarningStatus.HELD,
        ...NO_OPEN_CLAIM,
      },
      data: { status: EarningStatus.PENDING },
    });
    moved += p.count;
  }
  if (moved !== rows.length) throw raced();
  return { ready, pending };
}
