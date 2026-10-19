/**
 * An operator's hold and release of one earning, consultant or organisation.
 *
 * Hold places an OPERATOR hold on a PENDING or READY row. Release clears the
 * operator and moderation holds (the ones an admin disposes of) and is refused
 * while the payment has an open refund or dispute; a dispute or overage hold
 * stays until its own settlement releases it.
 */

import {
  EarningStatus,
  EarningsHoldReason,
  Prisma,
  RefundStatus,
} from "@prisma/client";

import { OpsRefusal } from "@/lib/backoffice/ops-refusal-error";
import { DISPUTE_INACTIVE_FOR_GATING } from "@/lib/payments/dispute-status";
import {
  EarningsHoldRaceError,
  placeEarningsHolds,
  releaseEarningsHolds,
  type EarningsHoldDb,
  type EarningsSide,
} from "./earnings-holds";

const HOLDABLE_FROM = new Set<EarningStatus>([
  EarningStatus.PENDING,
  EarningStatus.READY,
]);

/** The holds an operator release may clear. */
const OPERATOR_RELEASABLE: EarningsHoldReason[] = [
  EarningsHoldReason.OPERATOR,
  EarningsHoldReason.MODERATION,
];

const OPEN_CLAIMS = {
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
} satisfies Prisma.PaymentDefaultArgs;

function requireReason(reason: string) {
  if (reason.trim().length < 5) {
    throw new OpsRefusal(
      "REASON_REQUIRED",
      "Give a reason for this change.",
      400,
    );
  }
}

/** The earning and the table it lives in; consultant ids are tried first. */
async function readEarning(db: EarningsHoldDb, id: string) {
  const select = { id: true, status: true, payment: OPEN_CLAIMS } as const;
  const consultant = await db.consultantEarnings.findUnique({
    where: { id },
    select,
  });
  const row =
    consultant ??
    (await db.organizationEarnings.findUnique({ where: { id }, select }));
  if (!row) {
    throw new OpsRefusal("EARNING_NOT_FOUND", "Earning not found.", 404);
  }
  const side: EarningsSide = consultant ? "consultant" : "org";
  return {
    side,
    status: row.status,
    openClaims: row.payment.refunds.length + row.payment.disputes.length,
  };
}

const raced = () =>
  new OpsRefusal(
    "EARNING_CHANGED",
    "An earning changed while you were acting on it — reload and try again.",
  );

export async function holdEarnings(
  db: EarningsHoldDb,
  id: string,
  reason: string,
  opsActionId: string,
): Promise<{ side: EarningsSide; before: EarningStatus }> {
  requireReason(reason);
  const row = await readEarning(db, id);
  if (!HOLDABLE_FROM.has(row.status)) {
    throw new OpsRefusal(
      "EARNING_NOT_HOLDABLE",
      `Only pending or ready earnings can be held (this one is ${row.status}).`,
    );
  }
  try {
    const placed = await placeEarningsHolds(db, row.side, [id], {
      reason: EarningsHoldReason.OPERATOR,
      sourceRef: opsActionId,
      note: reason,
    });
    if (placed.length !== 1) throw raced();
  } catch (err) {
    if (err instanceof EarningsHoldRaceError) throw raced();
    throw err;
  }
  return { side: row.side, before: row.status };
}

export async function releaseHeldEarnings(
  db: EarningsHoldDb,
  id: string,
  reason: string,
  actorUserId: string,
  now = new Date(),
): Promise<{ side: EarningsSide; status: EarningStatus }> {
  requireReason(reason);
  const row = await readEarning(db, id);
  if (row.status !== EarningStatus.HELD) {
    throw new OpsRefusal(
      "EARNING_NOT_HELD",
      "Only held earnings can be released.",
    );
  }
  if (row.openClaims > 0) {
    throw new OpsRefusal(
      "EARNING_HAS_OPEN_CLAIM",
      "This payment has a refund or dispute still open — release once it settles.",
    );
  }
  const out = await releaseEarningsHolds(
    db,
    row.side,
    [id],
    { reasons: OPERATOR_RELEASABLE },
    { releasedById: actorUserId, now },
  );
  if (out.released.length === 0) {
    throw new OpsRefusal(
      "EARNING_HELD_BY_SETTLEMENT",
      "A dispute or an unpaid overage charge holds this earning; it is released when that settles.",
    );
  }
  return { side: row.side, status: out.restored.get(id) ?? EarningStatus.HELD };
}
