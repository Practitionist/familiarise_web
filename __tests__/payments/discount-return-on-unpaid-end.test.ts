/**
 * @jest-environment node
 */

/**
 * A discount-code use is given back only when a PENDING payment ends unpaid,
 * on the door that won the PENDING → terminal CAS; a capture that won keeps it.
 */
jest.mock("@/lib/referrals/service", () => ({
  reverseCreditsForPayment: jest.fn(async () => 0),
}));
jest.mock("@/lib/api/organizations/program-helpers", () => ({
  reverseBookingUtilization: jest.fn(async () => undefined),
}));
jest.mock("@/scripts/payments/cleanup-abandoned-payments", () => ({
  cancelPaymentIntent: jest.fn(),
}));
jest.mock("@/lib/observability/report", () => ({
  reportSentryError: jest.fn(),
}));

import { expirePendingPaymentsInTx } from "@/lib/booking/pending-payment-expiry";
import { returnDiscountUse } from "@/lib/payments/checkout/discount-use";
import type { Tx } from "@/lib/prisma";

function fakeTx(opts: { casWins: boolean; discountCodeId: string | null }) {
  const discountUpdates: unknown[] = [];
  const tx = {
    payment: {
      findMany: jest.fn(async () => [
        {
          id: "pay-1",
          paymentIntent: "order_1",
          paymentGateway: "RAZORPAY",
          isMockPayment: false,
        },
      ]),
      updateMany: jest.fn(async () => ({ count: opts.casWins ? 1 : 0 })),
      findUnique: jest.fn(async () => ({
        discountCodeId: opts.discountCodeId,
      })),
    },
    discountCode: {
      updateMany: jest.fn(async (args: unknown) => {
        discountUpdates.push(args);
        return { count: 1 };
      }),
    },
  };
  return { tx: tx as unknown as Tx, discountUpdates };
}

describe("discount use on an unpaid end", () => {
  it("returns the use when this door expires the PENDING payment", async () => {
    const { tx, discountUpdates } = fakeTx({
      casWins: true,
      discountCodeId: "dc-1",
    });
    await expirePendingPaymentsInTx(tx, {
      appointmentId: "appt-1",
      reason: "booking cancelled before payment",
    });
    expect(discountUpdates).toEqual([
      {
        where: { id: "dc-1", currentUses: { gt: 0 } },
        data: { currentUses: { decrement: 1 } },
      },
    ]);
  });

  it("keeps the use when a capture won the race", async () => {
    const { tx, discountUpdates } = fakeTx({
      casWins: false,
      discountCodeId: "dc-1",
    });
    await expirePendingPaymentsInTx(tx, {
      appointmentId: "appt-1",
      reason: "booking cancelled before payment",
    });
    expect(discountUpdates).toEqual([]);
  });

  it("touches no code when the checkout used none", async () => {
    const { tx, discountUpdates } = fakeTx({
      casWins: true,
      discountCodeId: null,
    });
    await returnDiscountUse(tx, "pay-1");
    expect(discountUpdates).toEqual([]);
  });
});
