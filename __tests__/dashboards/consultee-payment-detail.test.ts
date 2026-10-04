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
import {
  readConsulteePaymentDetail,
  REFUND_FAILED_NOTICE,
} from "@/lib/data/consultee-payment-detail";

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

it("answers null for another user's payment and never reads its refunds", async () => {
  const rows = [{ id: "pay-1", userId: "user-owner" }];
  (prisma.payment.findFirst as jest.Mock).mockImplementation(
    async ({ where }: { where: { id: string; userId: string } }) =>
      rows.find((r) => r.id === where.id && r.userId === where.userId) ?? null,
  );
  (prisma.refund.findMany as jest.Mock).mockClear();
  const detail = await readConsulteePaymentDetail({
    paymentId: "pay-1",
    consulteeId: "ce-9",
    userId: "user-intruder",
  });
  expect(detail).toBeNull();
  expect(prisma.refund.findMany).not.toHaveBeenCalled();
});

it("never selects or returns the gateway's raw refund failure text", async () => {
  const raw = "BAD_REQUEST_ERROR: insufficient balance in merchant account";
  const at = new Date("2026-09-01T10:00:00Z");
  (prisma.payment.findFirst as jest.Mock).mockResolvedValue({
    id: "pay-1",
    amount: 50000,
    originalAmount: 50000,
    taxAmount: 0,
    currency: "INR",
    paymentStatus: "SUCCEEDED",
    paymentMethod: "card",
    paymentGateway: "RAZORPAY",
    receiptUrl: null,
    expiresAt: null,
    createdAt: at,
    consumerInvoice: null,
    legs: [],
    refunds: [],
    disputes: [],
    organizationId: null,
    organization: null,
    discountCode: null,
    childPayments: [],
    appointment: null,
  });
  (prisma.refund.findMany as jest.Mock).mockImplementation(
    async ({ select }: { select: Record<string, boolean> }) => [
      {
        id: "ref-1",
        amountPaise: 50000,
        currency: "INR",
        status: "FAILED",
        refundId: "rfnd_ABC123",
        createdAt: at,
        updatedAt: at,
        ...(select.failureReason ? { failureReason: raw } : {}),
      },
    ],
  );
  const detail = await readConsulteePaymentDetail({
    paymentId: "pay-1",
    consulteeId: "ce-1",
    userId: "user-1",
  });
  const select = (prisma.refund.findMany as jest.Mock).mock.calls[0][0].select;
  expect(select).not.toHaveProperty("failureReason");
  expect(detail?.refunds[0]).toMatchObject({
    failureNotice: REFUND_FAILED_NOTICE,
    gatewayRefundId: "rfnd_ABC123",
  });
  expect(JSON.stringify(detail)).not.toContain(raw);
});
