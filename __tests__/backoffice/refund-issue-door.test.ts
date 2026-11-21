/**
 * @jest-environment node
 */

/**
 * #1824 QA — a gateway refund that threw after its keyed row was reserved is
 * in flight, not a 500: the door answers that PENDING row, a partial amount
 * keeps the seat, and the owed refund it settled by hand is reported.
 */

jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));
jest.mock("../../lib/auth-helpers", () => ({
  requireBackofficeSurface: jest.fn(async () => ({
    session: {
      user: { id: "admin_1", role: "ADMIN" },
      session: { createdAt: new Date() },
    },
  })),
}));
jest.mock("../../lib/backoffice/money-limit", () => ({
  assertMoneyOpsBudget: jest.fn(),
}));
// Eligibility has its own suite on real rows; this one pins the door's other contract.
jest.mock("../../lib/backoffice/refund-eligibility", () => ({
  assertRefundDoorOpen: jest.fn(async () => undefined),
}));
const create = jest.fn(async (_a: unknown) => ({ id: "row" }));
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    opsActionLog: { create: (a: unknown) => create(a) },
    refund: {
      findUnique: async () => ({
        metadata: {
          settledOwed: {
            key: "cancel:appt_1:pay_1",
            reason: "cancellation",
            owedPaise: 5_000,
            settledPaise: 100,
            stillOwedPaise: 4_900,
            note: "Settled ₹1.00 of the owed ₹50.00; ₹49.00 still owed and retrying.",
          },
        },
      }),
    },
  },
}));
const refundBookingPayment = jest.fn();
jest.mock("../../lib/payments/operations/booking-refund", () => ({
  refundBookingPayment: (...a: unknown[]) => refundBookingPayment(...a),
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
    settledOwed: { key: "cancel:appt_1:pay_1", stillOwedPaise: 4_900 },
  });
  expect(refundBookingPayment.mock.calls[0][0]).toMatchObject({
    keepSeatIfPartial: true,
    dedupeKey: "ops:11111111-2222-4333-8444-555555555555",
    settlesOwedByHand: true,
  });
});
