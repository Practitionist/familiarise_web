/**
 * @jest-environment node
 */

/**
 * #1824 QA — a gateway refund that threw after its keyed row was reserved is
 * in flight, not a 500: the door answers that PENDING row, and a partial
 * amount keeps the seat.
 */

jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));
jest.mock("../../lib/auth-helpers", () => ({
  requireBackofficeSurface: jest.fn(async () => ({
    session: { user: { id: "admin_1", role: "ADMIN" } },
  })),
}));
jest.mock("../../lib/backoffice/money-limit", () => ({
  assertMoneyOpsBudget: jest.fn(),
}));
const create = jest.fn(async (_a: unknown) => ({ id: "row" }));
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: { opsActionLog: { create: (a: unknown) => create(a) } },
}));
const refundBookingPayment = jest.fn();
jest.mock("../../lib/payments/operations/booking-refund", () => ({
  refundBookingPayment: (...a: unknown[]) => refundBookingPayment(...a),
  fundingRailForIntent: jest.fn(),
}));
jest.mock("../../lib/payments/operations/refund", () => {
  class RefundGatewayError extends Error {
    constructor(
      message: string,
      public code: string,
    ) {
      super(message);
    }
  }
  return {
    RefundGatewayError,
    RefundValidationError: class extends Error {},
    findDedupedRefund: async () => ({
      refundId: "ref_1",
      amountRefundedPaise: 100,
      status: "PENDING",
    }),
  };
});

import { NextRequest } from "next/server";
import { POST } from "../../app/api/admin/refunds/issue/route";
import { RefundGatewayError } from "../../lib/payments/operations/refund";

it("answers the reserved PENDING refund when the gateway call throws", async () => {
  refundBookingPayment.mockRejectedValueOnce(
    new (RefundGatewayError as unknown as new (m: string, c: string) => Error)(
      "gateway timeout",
      "GATEWAY_REFUND_FAILED",
    ),
  );
  const res = await POST(
    new NextRequest("https://x.test/api/admin/refunds/issue", {
      method: "POST",
      body: JSON.stringify({
        paymentId: "pay_1",
        amountPaise: 100,
        idempotencyKey: "11111111-2222-4333-8444-555555555555",
        reason: "goodwill for a late start",
      }),
    }),
    { params: Promise.resolve({}) },
  );
  expect(res.status).toBe(200);
  expect((await res.json()).result).toMatchObject({
    refundId: "ref_1",
    status: "PENDING",
  });
  expect(refundBookingPayment.mock.calls[0][0]).toMatchObject({
    keepSeat: true,
    dedupeKey: "ops:11111111-2222-4333-8444-555555555555",
  });
});
