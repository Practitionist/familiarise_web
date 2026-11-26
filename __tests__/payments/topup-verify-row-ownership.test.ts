/**
 * @jest-environment node
 */

/**
 * The top-up verify door proves ownership from the top-up row (its minted
 * order id) and the checkout signature. What the gateway payment's notes say,
 * or that they say nothing, never refuses the payer.
 */

jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));

const requireOrgAccess = jest.fn();
jest.mock("../../lib/auth-helpers", () => ({
  requireOrgAccess: (...a: unknown[]) => requireOrgAccess(...a),
}));
jest.mock("../../lib/rate-limit", () => ({
  checkoutLimiter: {},
  applyRateLimit: jest.fn().mockResolvedValue(null),
}));
jest.mock("../../app/api/webhooks/razorpay/signature", () => ({
  verifyRazorpaySignature: jest.fn().mockReturnValue(true),
}));

const topUpRow = jest.fn();
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: { walletTopUp: { findFirst: (...a: unknown[]) => topUpRow(...a) } },
}));

const paymentsFetch = jest.fn();
jest.mock("../../lib/payments/core/razorpay", () => ({
  getRazorpayClient: () => ({ payments: { fetch: paymentsFetch } }),
  withRazorpaySdkTimeout: (_op: string, call: () => unknown) => call(),
}));

const routeCapturedPayment = jest.fn();
jest.mock("../../app/api/webhooks/razorpay-dispatch", () => ({
  routeCapturedPayment: (...a: unknown[]) => routeCapturedPayment(...a),
}));

import type { NextRequest } from "next/server";
import { POST } from "../../app/api/organizations/[orgId]/billing-account/wallet/top-ups/[topUpId]/verify/route";

const ORDER = "order_TopUpOrder0001";
const PAY = "pay_TopUpPay000001";

const verify = () =>
  POST(
    {
      json: async () => ({
        razorpay_order_id: ORDER,
        razorpay_payment_id: PAY,
        razorpay_signature: "a".repeat(64),
      }),
    } as unknown as NextRequest,
    { params: Promise.resolve({ orgId: "org-1", topUpId: "we_1" }) },
  );

const gatewayPayment = (notes: unknown) => ({
  order_id: ORDER,
  status: "captured",
  amount: 50_000,
  currency: "INR",
  notes,
});

beforeEach(() => {
  jest.clearAllMocks();
  process.env.RAZORPAY_SECRET = "secret";
  requireOrgAccess.mockResolvedValue({ session: { user: { id: "u-1" } } });
  topUpRow
    .mockResolvedValueOnce({
      status: "PENDING",
      notes: `Top-up initiated by membership m1; razorpay_order=${ORDER}`,
    })
    .mockResolvedValue({ status: "CONFIRMED" });
});

it.each([
  ["no notes at all", []],
  ["notes of another shape", { type: "something_else" }],
])(
  "drives the capture pipeline when the payment carries %s",
  async (_label, notes) => {
    paymentsFetch.mockResolvedValue(gatewayPayment(notes));

    const res = await verify();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "confirmed" });
    expect(routeCapturedPayment).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId: ORDER,
        amountPaise: 50_000,
        gatewayPaymentId: PAY,
      }),
    );
  },
);

it("still refuses a payment whose order is not the one this top-up minted", async () => {
  topUpRow.mockReset();
  topUpRow.mockResolvedValue({
    status: "PENDING",
    notes: "razorpay_order=order_AnotherOrder01",
  });

  const res = await verify();

  expect(res.status).toBe(400);
  expect(routeCapturedPayment).not.toHaveBeenCalled();
});
