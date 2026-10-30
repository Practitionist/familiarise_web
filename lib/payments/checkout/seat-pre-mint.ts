// A webinar/class seat is committed under the event's checkout key with a
// pre-mint intent; the gateway order is minted after the key is released and
// filled into the row by CAS, so one buyer's gateway round trip never holds
// the next buyer behind the event mutex.

import { randomUUID } from "node:crypto";
import { PaymentStatus } from "@prisma/client";

import prisma from "@/lib/prisma";
import { PRE_MINT_INTENT_PREFIX } from "@/lib/payments/pre-mint-intent";
import { cancelGatewayOrders } from "@/lib/booking/pending-payment-expiry";
import { releaseSupersededHolds } from "@/lib/payments/checkout/order-reuse";
import type { PaymentGateway } from "@prisma/client";

export type GatewayOrder = { id: string; client_secret: string | null };

/** The placeholder intent a seat's PENDING row carries until its order exists. */
export function newSeatPreMintIntent(): GatewayOrder {
  return {
    id: `${PRE_MINT_INTENT_PREFIX}${randomUUID()}`,
    client_secret: null,
  };
}

export class SeatHoldLapsedError extends Error {
  readonly httpStatus = 409 as const;
  readonly code = "SEAT_HOLD_LAPSED" as const;
  constructor() {
    super(
      "Your seat hold ended before payment could open. Please start checkout again.",
    );
    this.name = "SeatHoldLapsedError";
  }
}

/** Carries a post-commit mint failure past the booking write's own error handling. */
export class SeatOrderMintFailure extends Error {
  constructor(readonly mintError: unknown) {
    super("The seat's gateway order could not be prepared");
    this.name = "SeatOrderMintFailure";
  }
}

/**
 * Mint the gateway order for a committed seat and fill it into the PENDING
 * row (and its CARD leg). A failed mint releases the seat and expires the
 * row; a fill that throws cancels the fresh order and does the same; a row
 * that lapsed meanwhile cancels the fresh order and refuses.
 */
export async function mintPreMintedSeatOrder(args: {
  preMintIntent: string;
  userId: string;
  gateway: PaymentGateway;
  mint: () => Promise<GatewayOrder>;
}): Promise<GatewayOrder> {
  let order: GatewayOrder;
  try {
    order = await args.mint();
  } catch (error) {
    await releasePreMintedSeat([args.preMintIntent], args.userId);
    throw error;
  }
  let filled: boolean;
  try {
    filled = await prisma.$transaction(async (tx) => {
      const moved = await tx.payment.updateMany({
        where: {
          paymentIntent: args.preMintIntent,
          paymentStatus: PaymentStatus.PENDING,
        },
        data: { paymentIntent: order.id },
      });
      if (moved.count === 0) return false;
      await tx.paymentLeg.updateMany({
        where: { sourceRef: args.preMintIntent },
        data: { sourceRef: order.id },
      });
      return true;
    });
  } catch (fillError) {
    // Nobody can pay an order whose row may not carry it; the row is released
    // under whichever intent it holds, in case the fill committed after all.
    await cancelGatewayOrders(
      [{ paymentIntent: order.id, gateway: args.gateway }],
      {
        op: "checkout.seat-pre-mint-fill-failed",
        appointmentId: args.preMintIntent,
      },
    );
    await releasePreMintedSeat([args.preMintIntent, order.id], args.userId);
    throw fillError;
  }
  if (!filled) {
    await cancelGatewayOrders(
      [{ paymentIntent: order.id, gateway: args.gateway }],
      {
        op: "checkout.seat-pre-mint-lapsed",
        appointmentId: args.preMintIntent,
      },
    );
    throw new SeatHoldLapsedError();
  }
  return order;
}

async function releasePreMintedSeat(
  intents: string[],
  userId: string,
): Promise<void> {
  const rows = await prisma.payment.findMany({
    where: { paymentIntent: { in: intents } },
    select: { id: true },
  });
  if (rows.length > 0) {
    await releaseSupersededHolds({
      userId,
      paymentIds: rows.map((row) => row.id),
    });
  }
}
