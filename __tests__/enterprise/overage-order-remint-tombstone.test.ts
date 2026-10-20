/**
 * @jest-environment node
 */

// Re-minting a member overage order moves the replaced order to a tombstone in the CAS transaction.

const tx = {
  payment: { updateMany: jest.fn() },
  paymentLeg: { create: jest.fn() },
};
const mockPrisma = {
  overageEvent: { findUnique: jest.fn() },
  payment: { findUnique: jest.fn() },
  $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
};
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  get default() {
    return mockPrisma;
  },
}));
jest.mock("../../lib/auth-helpers", () => ({
  requireApiAuth: jest.fn(async () => ({ session: { user: { id: "u1" } } })),
}));
jest.mock("../../lib/payments/core/razorpay", () => ({
  createRazorpayOrder: jest.fn(async () => ({
    id: "order_new",
    amount: 129_500,
    currency: "INR",
  })),
  getRazorpayClient: () => null,
  withRazorpaySdkTimeout: jest.fn(),
}));
jest.mock("../../lib/payments/billing/overage-transitions", () => ({
  transitionOverage: jest.fn(async () => 0),
}));
jest.mock("../../lib/payments/billing/overage-base-carve", () => ({
  recarveOverageBase: jest.fn(),
}));
const mockTombstone = jest.fn();
jest.mock("../../lib/payments/operations/prior-intent-tombstone", () => ({
  tombstonePriorIntent: (...a: unknown[]) => mockTombstone(...a),
}));

import { NextRequest } from "next/server";
import { POST } from "@/app/api/overage/[overageEventId]/order/route";

const sidePayment = {
  id: "side1",
  userId: "u1",
  currency: "INR",
  paymentStatus: "FAILED",
  paymentIntent: "order_old",
  gatewayPaymentId: "pay_old",
  amount: 129_500,
  originalAmount: 125_000,
  taxAmount: 4_500,
  paymentGateway: "RAZORPAY",
};

const call = () =>
  POST(new NextRequest("http://x/api/overage/ev1/order", { method: "POST" }), {
    params: Promise.resolve({ overageEventId: "ev1" }),
  });

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.overageEvent.findUnique.mockResolvedValue({
    id: "ev1",
    overageBehavior: "CHARGE_MEMBER",
    chargeStatus: "FAILED",
    marginalPaise: 129_500,
    currency: "INR",
    payment: sidePayment,
  });
});

it("re-points by CAS on the prior intent and tombstones the replaced order", async () => {
  tx.payment.updateMany.mockResolvedValue({ count: 1 });

  const res = await call();

  expect(res.status).toBe(200);
  expect(tx.payment.updateMany).toHaveBeenCalledWith({
    where: {
      id: "side1",
      paymentIntent: "order_old",
      gatewayPaymentId: "pay_old",
      paymentStatus: { not: "SUCCEEDED" },
    },
    data: {
      paymentIntent: "order_new",
      paymentStatus: "PENDING",
      gatewayPaymentId: null,
    },
  });
  expect(mockTombstone).toHaveBeenCalledWith(
    tx,
    expect.objectContaining({
      id: "side1",
      paymentIntent: "order_old",
      gatewayPaymentId: "pay_old",
    }),
    "overage charge re-minted",
  );
  expect(tx.paymentLeg.create).toHaveBeenCalledWith({
    data: {
      paymentId: "side1",
      source: "CARD",
      amountPaise: 129_500,
      sourceRef: "order_new",
    },
  });
});

it("first mint over the overage placeholder intent writes no tombstone and no leg", async () => {
  mockPrisma.overageEvent.findUnique.mockResolvedValue({
    id: "ev1",
    overageBehavior: "CHARGE_MEMBER",
    chargeStatus: "PENDING",
    marginalPaise: 129_500,
    currency: "INR",
    payment: {
      ...sidePayment,
      paymentStatus: "PENDING",
      paymentIntent: "overage:ev1",
      gatewayPaymentId: null,
    },
  });
  tx.payment.updateMany.mockResolvedValue({ count: 1 });

  const res = await call();

  expect(res.status).toBe(200);
  expect(tx.payment.updateMany).toHaveBeenCalledWith(
    expect.objectContaining({
      where: expect.objectContaining({
        paymentIntent: "overage:ev1",
        gatewayPaymentId: null,
      }),
    }),
  );
  expect(mockTombstone).not.toHaveBeenCalled();
  expect(tx.paymentLeg.create).not.toHaveBeenCalled();
});

it.each([
  ["PENDING", "OVERAGE_ORDER_RACED"],
  ["SUCCEEDED", undefined],
])(
  "writes no tombstone when the CAS loses to a %s row",
  async (status, code) => {
    tx.payment.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.payment.findUnique.mockResolvedValue({ paymentStatus: status });

    const res = await call();

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe(code);
    expect(mockTombstone).not.toHaveBeenCalled();
    expect(tx.paymentLeg.create).not.toHaveBeenCalled();
  },
);
