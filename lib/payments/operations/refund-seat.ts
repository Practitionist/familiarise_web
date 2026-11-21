/** The booking seat a refund ends, decided once when its row is written and stored in its metadata. */

import type { Prisma } from "@prisma/client";
import { z } from "zod";

export type SeatPolicy = {
  amountPaise?: number;
  /** The seat stays live whatever is returned. */
  keepSeat?: boolean;
  /** The seat stays live only while an explicit amount leaves part of the payment refundable. */
  keepSeatIfPartial?: boolean;
};

/** A refund ends the funded seat unless it keeps it, or keeps it while an explicit amount leaves a balance. */
export function refundEndsSeat(
  policy: SeatPolicy,
  requestedPaise: number,
  refundablePaise: number,
): boolean {
  const partial =
    policy.amountPaise !== undefined && requestedPaise < refundablePaise;
  return !policy.keepSeat && !(policy.keepSeatIfPartial && partial);
}

const STORED_SEAT_DECISION = z.object({ endsSeat: z.boolean() });

/** The `endsSeat` decision a refund row's metadata recorded, or undefined on a row written before it was stored. */
export function storedSeatDecision(
  metadata: Prisma.JsonValue | null | undefined,
): boolean | undefined {
  const parsed = STORED_SEAT_DECISION.safeParse(metadata);
  return parsed.success ? parsed.data.endsSeat : undefined;
}
