/**
 * #1771 K-3 — an operator's hold and release of consultant earnings.
 *
 * Hold: PENDING|READY → HELD. Release: HELD → the recorded preDisputeStatus
 * (#1020-1), else READY/PENDING by hold maturity; never while the payment has
 * an open refund or dispute. One CAS per status group; a short count is a 409.
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
      preDisputeStatus: true,
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
): Promise<{ ready: string[]; pending: string[]; trust: string[] }> {
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

  // #1020-1 — the recorded prior wins: a PENDING_TRUST freeze returns to
  // PENDING_TRUST so the invoice-fraud gate keeps owning the release.
  const trust: string[] = [];
  const priorPending: string[] = [];
  const priorReady: string[] = [];
  const blankReady: string[] = [];
  const blankPending: string[] = [];
  for (const r of rows) {
    switch (r.preDisputeStatus) {
      case EarningStatus.PENDING_TRUST:
        trust.push(r.id);
        break;
      case EarningStatus.PENDING:
        priorPending.push(r.id);
        break;
      case EarningStatus.READY:
        priorReady.push(r.id);
        break;
      default: {
        // No recorded prior (operator hold, or pre-#1020): the hold-window rule,
        // READY once holdUntil has passed, PENDING until then.
        const matured = Boolean(r.holdUntil && r.holdUntil <= now);
        (matured ? blankReady : blankPending).push(r.id);
      }
    }
  }

  // One CAS per group, with that group's own predicate repeated in the WHERE —
  // a row the dispute release moved out from under us matches nothing and the
  // count falls short of rows.length, which is the 409 below.
  let moved = 0;
  const restore = async (
    group: string[],
    to: EarningStatus,
    prior: EarningStatus | null,
    maturedOnly = false,
  ) => {
    if (group.length === 0) return;
    for (const id of group)
      assertEarningStatusTransitionLegal(id, EarningStatus.HELD, to);
    const r = await db.consultantEarnings.updateMany({
      where: {
        id: { in: group },
        status: EarningStatus.HELD,
        preDisputeStatus: prior,
        ...(maturedOnly ? { holdUntil: { lte: now } } : {}),
        ...NO_OPEN_CLAIM,
      },
      // Cleared on every group, as the dispute release does: a marker left set
      // would be read as the next hold's intent.
      data: { status: to, preDisputeStatus: null },
    });
    moved += r.count;
  };

  await restore(
    trust,
    EarningStatus.PENDING_TRUST,
    EarningStatus.PENDING_TRUST,
  );
  await restore(priorPending, EarningStatus.PENDING, EarningStatus.PENDING);
  await restore(priorReady, EarningStatus.READY, EarningStatus.READY);
  await restore(blankReady, EarningStatus.READY, null, true);
  await restore(blankPending, EarningStatus.PENDING, null);

  if (moved !== rows.length) throw raced();
  return {
    ready: [...priorReady, ...blankReady],
    pending: [...priorPending, ...blankPending],
    trust,
  };
}
