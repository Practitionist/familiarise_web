/** A refund front door for the database tier that writes real Refund rows. */
import { randomUUID } from "node:crypto";
import prisma from "../../../lib/prisma";
import { RefundValidationError } from "../../../lib/payments/operations/refund";
import {
  REFUNDABLE_BALANCE_SELECT,
  refundableBalancePaise,
} from "../../../lib/payments/refundable-balance";

type RefundArgs = {
  paymentId: string;
  amountPaise?: number;
  dedupeKey?: string;
};

/** The front door's money rules on real rows: keyed, and never past the balance. */
export async function refundOnRows(args: RefundArgs) {
  if (args.dedupeKey) {
    const prior = await prisma.refund.findUnique({
      where: { dedupeKey: args.dedupeKey },
    });
    if (prior) {
      return {
        refundId: prior.id,
        amountRefundedPaise: Number(prior.amountPaise),
        rail: "GATEWAY" as const,
        status: "SUCCEEDED" as const,
      };
    }
  }
  const payment = await prisma.payment.findUniqueOrThrow({
    where: { id: args.paymentId },
    select: { amount: true, ...REFUNDABLE_BALANCE_SELECT },
  });
  const balance = refundableBalancePaise(Number(payment.amount), payment);
  if (balance <= 0) {
    throw new RefundValidationError("nothing left", "ALREADY_FULLY_REFUNDED");
  }
  const amount = args.amountPaise ?? balance;
  if (amount > balance) {
    throw new RefundValidationError("too much", "AMOUNT_EXCEEDS_REFUNDABLE");
  }
  const row = await prisma.refund.create({
    data: {
      paymentId: args.paymentId,
      amountPaise: BigInt(amount),
      status: "SUCCEEDED",
      refundId: `rfnd_dbtier_${randomUUID()}`,
      dedupeKey: args.dedupeKey ?? null,
      paymentGateway: "RAZORPAY",
    },
  });
  return {
    refundId: row.id,
    amountRefundedPaise: amount,
    rail: "GATEWAY" as const,
    status: "SUCCEEDED" as const,
  };
}

/** Money returned on a payment, read straight from its Refund rows. */
export const refundedPaise = async (paymentId: string) =>
  (
    await prisma.refund.findMany({
      where: { paymentId, status: { in: ["SUCCEEDED", "PENDING"] } },
      select: { amountPaise: true },
    })
  ).reduce((sum, r) => sum + Number(r.amountPaise), 0);
