/**
 * @jest-environment node
 */

/**
 * refundPayment is the gateway door only: an org-funded or credit-funded intent
 * is refused before any Refund row is reserved.
 */

const paymentFindUnique = jest.fn();
const transaction = jest.fn();
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    payment: { findUnique: (...a: unknown[]) => paymentFindUnique(...a) },
    $transaction: (...a: unknown[]) => transaction(...a),
  },
}));

import { refundPayment } from "@/lib/payments/operations/refund";

describe("refundPayment — gateway rail only", () => {
  it.each(["org_wallet_1", "free_1"])(
    "refuses a %s intent before reserving anything",
    async (paymentIntent) => {
      paymentFindUnique.mockResolvedValueOnce({
        id: "pay-1",
        amount: 10_000,
        currency: "INR",
        paymentStatus: "SUCCEEDED",
        paymentGateway: "RAZORPAY",
        paymentIntent,
        refunds: [],
      });

      await expect(
        refundPayment({ paymentId: "pay-1", reason: "wrong door" }),
      ).rejects.toMatchObject({ code: "NOT_A_GATEWAY_PAYMENT" });
      expect(transaction).not.toHaveBeenCalled();
    },
  );
});
