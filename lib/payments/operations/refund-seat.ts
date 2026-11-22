/**
 * The booking seat a refund ends. The reserving request's seat intent is stored on the row, and the
 * refund decides from it once, in the transaction that settles it as SUCCEEDED, storing `endsSeat`.
 */

import { RefundStatus, type Prisma } from "@prisma/client";
import { z } from "zod";

import type { Tx } from "@/lib/prisma";
import { transitionParticipant } from "@/lib/booking/participants";
import {
  REFUNDABLE_BALANCE_SELECT,
  RETURNED_DISPUTE_STATUSES,
} from "@/lib/payments/refundable-balance";
import { persistRefundRevocationInTx } from "@/lib/stream/revocation-intents";

export type SeatPolicy = {
  amountPaise?: number;
  /** The seat stays live whatever is returned. */
  keepSeat?: boolean;
  /** The seat stays live only while an explicit amount leaves part of the payment refundable. */
  keepSeatIfPartial?: boolean;
};

const SEAT_INTENT = z.object({
  keepSeat: z.boolean(),
  keepSeatIfPartial: z.boolean(),
  amountNamed: z.boolean(),
});

/** What the reserving request asked of the seat, stored as `Refund.metadata.seatIntent`. */
export type SeatIntent = z.infer<typeof SEAT_INTENT>;

export function seatIntentOf(policy: SeatPolicy): SeatIntent {
  return {
    keepSeat: policy.keepSeat === true,
    keepSeatIfPartial: policy.keepSeatIfPartial === true,
    amountNamed: policy.amountPaise !== undefined,
  };
}

/** A row from before the intent was stored ends the seat only once nothing is left to refund. */
export function legacySeatIntent(keepSeat: boolean | undefined): SeatIntent {
  return {
    keepSeat: keepSeat === true,
    keepSeatIfPartial: true,
    amountNamed: true,
  };
}

/** A refund ends the seat unless it keeps it, or keeps it while an explicit amount leaves a balance. */
function seatEndsLeaving(intent: SeatIntent, leftPaise: number): boolean {
  const partial = intent.amountNamed && leftPaise > 0;
  return !intent.keepSeat && !(intent.keepSeatIfPartial && partial);
}

const jsonObject = (
  value: Prisma.JsonValue | null | undefined,
): Prisma.JsonObject =>
  value && typeof value === "object" && !Array.isArray(value) ? value : {};

const STORED_SEAT_DECISION = z.object({ endsSeat: z.boolean() });

/** The `endsSeat` decision a refund row's metadata recorded, or undefined while none is stored. */
export function storedSeatDecision(
  metadata: Prisma.JsonValue | null | undefined,
): boolean | undefined {
  const parsed = STORED_SEAT_DECISION.safeParse(metadata);
  return parsed.success ? parsed.data.endsSeat : undefined;
}

const STORED_SEAT_INTENT = z.object({ seatIntent: SEAT_INTENT });

/** The reserving request's seat intent, or undefined on a row written before it was stored. */
export function storedSeatIntent(
  metadata: Prisma.JsonValue | null | undefined,
): SeatIntent | undefined {
  const parsed = STORED_SEAT_INTENT.safeParse(metadata);
  return parsed.success ? parsed.data.seatIntent : undefined;
}

/** The history row of an event learner seat a refund ends; a 1:1 seat gets none. */
export const refundedSeat = (actorUserId: string | null | undefined) => ({
  history: { reason: "refunded" as const, actorUserId: actorUserId ?? null },
});

/** A settled refund's seat decision, and the revocation intent its transaction wrote when it ended the seat. */
export type SeatDecision = {
  endsSeat: boolean;
  revocationGeneration: Date | null;
};

const KEEP_SEAT: SeatDecision = { endsSeat: false, revocationGeneration: null };

/**
 * Decides a SUCCEEDED refund's seat once, in the Serializable transaction that settled it, counting only SUCCEEDED
 * refunds and lost chargebacks; ending it stamps the seat REFUNDED and writes the payer's revocation intent there too.
 */
export async function settleRefundSeatTx(
  tx: Tx,
  refundRowId: string,
  opts: {
    actorUserId?: string | null;
    fallbackIntent?: SeatIntent;
  } = {},
): Promise<SeatDecision> {
  const row = await tx.refund.findUnique({
    where: { id: refundRowId },
    select: {
      status: true,
      paymentId: true,
      metadata: true,
      payment: {
        select: { amount: true, userId: true, ...REFUNDABLE_BALANCE_SELECT },
      },
    },
  });
  if (!row || row.status !== RefundStatus.SUCCEEDED) return KEEP_SEAT;
  const stored = storedSeatDecision(row.metadata);
  if (stored !== undefined)
    return { endsSeat: stored, revocationGeneration: null };
  const intent = storedSeatIntent(row.metadata) ?? opts.fallbackIntent;
  // A refund no booking door asked for (a dashboard refund, a capture auto-refund) leaves the seat alone.
  if (!intent) return KEEP_SEAT;
  const { payment } = row;
  const returnedPaise =
    payment.refunds
      .filter((r) => r.status === RefundStatus.SUCCEEDED)
      .reduce((sum, r) => sum + r.amountPaise, 0) +
    payment.disputes
      .filter((d) => RETURNED_DISPUTE_STATUSES.has(d.status))
      .reduce((sum, d) => sum + d.amountPaise, 0);
  const endsSeat = seatEndsLeaving(intent, payment.amount - returnedPaise);
  const stamped = await tx.refund.updateMany({
    where: { id: refundRowId, status: RefundStatus.SUCCEEDED },
    data: { metadata: { ...jsonObject(row.metadata), endsSeat } },
  });
  if (stamped.count !== 1) {
    throw new Error(`Refund ${refundRowId} left SUCCEEDED while settling`);
  }
  if (!endsSeat) return KEEP_SEAT;
  await transitionParticipant(
    tx,
    { paymentId: row.paymentId },
    "REFUNDED",
    refundedSeat(opts.actorUserId),
  );
  const revocationGeneration = await persistRefundRevocationInTx(tx, {
    refundId: refundRowId,
    payerUserId: payment.userId,
  });
  return { endsSeat, revocationGeneration };
}
