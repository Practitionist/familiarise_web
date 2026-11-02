/**
 * @jest-environment node
 */

/**
 * The buyer's verify door: a PENDING purchase whose order holds only failed
 * attempts moves to FAILED by CAS, an order still unattempted stays PENDING,
 * and a FAILED purchase stays recoverable by a later capture.
 */
const mockRow = { status: "PENDING" as string };
const mockHolding = jest.fn();
const mockRoute = jest.fn();
const mockUpdateMany = jest.fn(
  async ({ where }: { where: { status: string } }) => {
    if (where.status !== mockRow.status) return { count: 0 };
    mockRow.status = "FAILED";
    return { count: 1 };
  },
);

jest.mock("../../lib/auth-helpers", () => ({
  requireApiAuth: async () => ({ session: { user: { id: "buyer_1" } } }),
}));
jest.mock("../../lib/rate-limit", () => ({
  applyRateLimit: async () => null,
  moneyOpsLimiter: {},
}));
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    digitalProductPurchase: {
      findFirst: async () => ({
        status: mockRow.status,
        gatewayOrderId: "order_1",
        createdAt: new Date(),
      }),
      findUnique: async () => ({ id: "dpp_1", status: mockRow.status }),
      updateMany: (args: { where: { status: string } }) => mockUpdateMany(args),
    },
  },
}));
jest.mock("../../lib/payments/core/razorpay", () => ({
  readRazorpayOrderHolding: (id: string) => mockHolding(id),
  fetchRazorpayOrder: async (id: string) => ({
    id,
    notes: { type: "digital_product_purchase" },
  }),
}));
jest.mock("../../app/api/webhooks/razorpay-dispatch", () => ({
  routeCapturedPayment: (...a: unknown[]) => mockRoute(...a),
}));
jest.mock("../../lib/cron/with-cron-lock", () => ({ withCronLock: jest.fn() }));
jest.mock("../../lib/digital-products/purchase-email", () => ({}));
jest.mock("../../lib/payments/payouts/earnings-service", () => ({}));
jest.mock("../../lib/payments/billing/consumer-invoice", () => ({}));
jest.mock("../../lib/payments/operations/booking-refund", () => ({}));
jest.mock("../../lib/payments/ledger/unapplied-receipts", () => ({}));
jest.mock("../../lib/observability/report", () => ({
  reportSentryError: jest.fn(),
}));

import { POST as verify } from "../../app/api/digital-products/purchases/[purchaseId]/verify/route";

const call = async () => {
  const res = await verify(new Request("http://localhost/x"), {
    params: Promise.resolve({ purchaseId: "dpp_1" }),
  });
  return (await res.json()) as { data: { status: string } };
};

it("fails a PENDING order whose every attempt failed and keeps FAILED recoverable", async () => {
  mockHolding.mockResolvedValue({ kind: "empty", onlyFailed: false });
  await expect(call()).resolves.toMatchObject({ data: { status: "PENDING" } });
  expect(mockUpdateMany).not.toHaveBeenCalled();

  mockHolding.mockResolvedValue({ kind: "empty", onlyFailed: true });
  await expect(call()).resolves.toMatchObject({ data: { status: "FAILED" } });
  expect(mockUpdateMany).toHaveBeenCalledWith({
    where: { gatewayOrderId: "order_1", status: "PENDING" },
    data: { status: "FAILED" },
  });

  // A retry captured on the same order still routes from FAILED.
  mockHolding.mockResolvedValue({
    kind: "captured",
    paymentId: "pay_R",
    amountPaise: 59_000,
  });
  await call();
  expect(mockRoute).toHaveBeenCalledWith(
    expect.objectContaining({ orderId: "order_1", gatewayPaymentId: "pay_R" }),
  );
  expect(mockUpdateMany).toHaveBeenCalledTimes(1);
});
