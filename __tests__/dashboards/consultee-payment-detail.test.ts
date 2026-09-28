/**
 * @jest-environment node
 */

/**
 * #1527 Q5 — the payment detail read answers only for a top-level charge the
 * profile's own user paid; any other id reads as not found, before any
 * refund or credit-note read runs.
 */

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    payment: { findFirst: jest.fn() },
    refund: { findMany: jest.fn() },
    consumerCreditNote: { findMany: jest.fn() },
  },
}));

import prisma from "@/lib/prisma";
import { readConsulteePaymentDetail } from "@/lib/data/consultee-payment-detail";

it("binds the charge to the payer and answers null for anyone else's", async () => {
  (prisma.payment.findFirst as jest.Mock).mockResolvedValue(null);
  const detail = await readConsulteePaymentDetail({
    paymentId: "pay-1",
    consulteeId: "ce-1",
    userId: "user-1",
  });
  expect(detail).toBeNull();
  expect(
    (prisma.payment.findFirst as jest.Mock).mock.calls[0][0].where,
  ).toEqual({
    id: "pay-1",
    userId: "user-1",
    user: { consulteeProfileId: "ce-1" },
    parentPaymentId: null,
    deletedAt: null,
  });
  expect(prisma.refund.findMany).not.toHaveBeenCalled();
});
