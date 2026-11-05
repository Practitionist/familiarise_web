/**
 * Releases one held top-up's OPERATOR hold, and only that hold: another
 * top-up's hold on the same earnings stays. Refused until the top-up is paid,
 * while another top-up on the payment is still unpaid, and while a refund or a
 * dispute on the payment is still open.
 */

import {
  EarningsHoldReason,
  EarningStatus,
  RefundStatus,
} from "@prisma/client";

import type { Tx } from "@/lib/prisma";
import { DISPUTE_INACTIVE_FOR_GATING } from "@/lib/payments/dispute-status";
import {
  OWED_ALREADY_HELD_PREFIX,
  releaseEarningsHolds,
} from "@/lib/payments/payouts/earnings-holds";
import { OpsRefusal } from "./ops-refusal-error";
import { topUpStatuses } from "./needs-human";

export async function releaseTopUpHold(
  tx: Tx,
  correlationId: string,
  actorUserId: string,
): Promise<{ paymentId: string; released: number }> {
  const paymentId = correlationId.startsWith(OWED_ALREADY_HELD_PREFIX)
    ? correlationId.slice(OWED_ALREADY_HELD_PREFIX.length).split(":")[0]
    : "";
  const status = paymentId
    ? (await topUpStatuses(tx, [paymentId])).get(correlationId)
    : undefined;
  if (!status) {
    throw new OpsRefusal("TOP_UP_NOT_FOUND", "This top-up was not found.", 404);
  }
  if (status.owed > 0) {
    throw new OpsRefusal(
      "TOP_UP_UNPAID",
      "This top-up is still owed to the buyer. Refund it first; its hold stays until then.",
    );
  }
  if (status.otherUnpaid) {
    throw new OpsRefusal(
      "OTHER_TOP_UP_UNPAID",
      "Another top-up on this payment is still owed. Release the holds once it is paid.",
    );
  }
  const open = await tx.payment.findUnique({
    where: { id: paymentId },
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
  });
  if ((open?.refunds.length ?? 0) + (open?.disputes.length ?? 0) > 0) {
    throw new OpsRefusal(
      "EARNING_HAS_OPEN_CLAIM",
      "This payment has a refund or dispute still open — release once it settles.",
    );
  }
  const where = { paymentId, status: EarningStatus.HELD };
  const consultant = await tx.consultantEarnings.findMany({
    where,
    select: { id: true },
  });
  const org = await tx.organizationEarnings.findMany({
    where,
    select: { id: true },
  });
  const match = {
    reasons: [EarningsHoldReason.OPERATOR],
    sourceRef: correlationId,
  };
  const opts = { releasedById: actorUserId };
  const released = [
    ...(
      await releaseEarningsHolds(
        tx,
        "consultant",
        consultant.map((r) => r.id),
        match,
        opts,
      )
    ).released,
    ...(
      await releaseEarningsHolds(
        tx,
        "org",
        org.map((r) => r.id),
        match,
        opts,
      )
    ).released,
  ];
  if (released.length === 0) {
    throw new OpsRefusal(
      "HOLD_ALREADY_RELEASED",
      "This top-up's hold is already released.",
    );
  }
  return { paymentId, released: released.length };
}
