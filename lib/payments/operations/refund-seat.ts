/**
 * The booking seat a refund ends. The reserving request's seat intent is stored on the row, and the
 * decision is made from that intent once the money is final, then stored beside it.
 */

import type { Prisma } from "@prisma/client";
import { z } from "zod";

import type { Tx } from "@/lib/prisma";
import { RETURNED_REFUND_STATUSES } from "@/lib/payments/refundable-balance";
import { sumPaise } from "@/lib/payments/utils/money";

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

/** A refund ends the funded seat unless it keeps it, or keeps it while an explicit amount leaves a balance. */
export function refundEndsSeat(
  policy: SeatPolicy,
  requestedPaise: number,
  refundablePaise: number,
): boolean {
  return seatEndsLeaving(
    seatIntentOf(policy),
    refundablePaise - requestedPaise,
  );
}

/** The same rule, given what stays refundable once this refund is counted. */
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

/** Written on a gateway reservation; the finalisation replaces it with `endsSeat`. */
export const SEAT_DECISION_PENDING = { seatDecision: "pending" } as const;
const PENDING_SEAT_DECISION = z.object({ seatDecision: z.literal("pending") });

/** True while the call that reserved this refund still owns its seat decision and effects. */
export function seatDecisionPending(
  metadata: Prisma.JsonValue | null | undefined,
): boolean {
  return (
    storedSeatDecision(metadata) === undefined &&
    PENDING_SEAT_DECISION.safeParse(metadata).success
  );
}

/** The metadata without the pending marker. */
export function withoutSeatMarker(
  metadata: Prisma.JsonValue | null | undefined,
): Prisma.JsonObject {
  const { seatDecision: _marker, ...rest } = jsonObject(metadata);
  return rest;
}

/**
 * Decides and stores a refund's seat from the intent stored on its row (else `intent`), against the
 * payment's committed balance read through `tx`: a concurrent refund that failed meanwhile counts as
 * refundable. A decision already stored on the row wins.
 */
export async function decideRefundSeatTx(
  tx: Pick<Tx, "refund" | "dispute">,
  args: {
    refundRowId: string;
    paymentId: string;
    paymentPaise: number;
    /** The caller's own intent, used only for a row that stores none. */
    intent?: SeatIntent;
  },
): Promise<boolean> {
  // One read: the payment's refunds give the balance, and this row's stored intent and decision.
  const refunds = await tx.refund.findMany({
    where: { paymentId: args.paymentId },
    select: { id: true, amountPaise: true, status: true, metadata: true },
  });
  const row = refunds.find((r) => r.id === args.refundRowId);
  const stored = storedSeatDecision(row?.metadata);
  if (stored !== undefined) return stored;
  const intent = storedSeatIntent(row?.metadata) ?? args.intent;
  // No intent anywhere: keep the seat rather than guess.
  if (!intent) return false;
  const chargedBack = await tx.dispute.aggregate({
    where: {
      paymentId: args.paymentId,
      // The verdicts where the bank already pulled the money, as RETURNED_DISPUTE_STATUSES lists.
      status: { in: ["LOST", "CHARGE_REFUNDED"] },
    },
    _sum: { amountPaise: true },
  });
  const returnedPaise = refunds
    .filter((r) => RETURNED_REFUND_STATUSES.has(r.status))
    .reduce((sum, r) => sum + Number(r.amountPaise), 0);
  const leftPaise =
    args.paymentPaise - returnedPaise - sumPaise(chargedBack._sum.amountPaise);
  const endsSeat = seatEndsLeaving(intent, leftPaise);
  if (row) {
    await tx.refund.update({
      where: { id: row.id },
      data: { metadata: { ...withoutSeatMarker(row.metadata), endsSeat } },
    });
  }
  return endsSeat;
}
