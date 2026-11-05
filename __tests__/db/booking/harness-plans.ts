/**
 * Plan payments for the database tier.
 */
import { randomUUID } from "node:crypto";
import prisma from "../../../lib/prisma";

/** A captured, card-only payment of `pricePaise` on the appointment. */
export function seedCardPayment(
  userId: string,
  appointmentId: string,
  pricePaise: number,
) {
  const amount = BigInt(pricePaise);
  return prisma.payment.create({
    data: {
      amount,
      originalAmount: amount,
      paymentMethod: "card",
      paymentIntent: `order_dbtier_${randomUUID()}`,
      paymentGateway: "RAZORPAY",
      paymentStatus: "SUCCEEDED",
      userId,
      appointmentId,
      isMockPayment: true,
      legs: { create: [{ source: "CARD", amountPaise: amount }] },
      expiresAt: null,
    },
  });
}
