/**
 * A digital product capture either settles its purchase atomically (purchase,
 * Payment, CARD leg, purchase link, earnings, receipt staging) or is staged
 * under the auto-refund marker and refunded after commit; a capture on a
 * failed attempt's order is recovered by the sweep; a full refund revokes the
 * entitlement by its explicit purchase link, never by "appointment-less".
 */
const mockTx = {
  $executeRaw: jest.fn(),
  digitalProduct: { findFirst: jest.fn() },
  digitalProductPurchase: {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    updateMany: jest.fn(),
  },
  recordingPurchase: { updateMany: jest.fn() },
  payment: { findUnique: jest.fn(), create: jest.fn(), updateMany: jest.fn() },
  user: { findUnique: jest.fn() },
};
const mockSettleMarker = jest.fn();
const mockRefund = jest.fn();
const mockCreateEarnings = jest.fn();
const mockMintInvoice = jest.fn();
const mockStageReceipt = jest.fn();
const mockFlushReceipt = jest.fn();
const mockPurchaseRow = { status: "PENDING" };
const mockHolding = jest.fn();
const mockPaymentLookup = jest.fn();

jest.mock("../../lib/payments/ledger/unapplied-receipts", () => ({
  postUnappliedReceipt: jest.fn(),
}));
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    $transaction: (cb: (tx: typeof mockTx) => Promise<unknown>) => cb(mockTx),
    payment: {
      findUnique: (...a: unknown[]) => mockPaymentLookup(...a),
      updateMany: (...a: unknown[]) => mockSettleMarker(...a),
    },
    digitalProductPurchase: {
      findUnique: async () => ({
        id: "dpp-1",
        buyerId: "u-1",
        productId: "dp-1",
        amountPaise: 59000,
        status: mockPurchaseRow.status,
      }),
      findMany: async ({ where }: { where: { status: string } }) =>
        where.status === "FAILED" && mockPurchaseRow.status === "FAILED"
          ? [
              {
                id: "dpp-1",
                gatewayOrderId: "order_f",
                status: "FAILED",
                createdAt: new Date(Date.now() - 2 * 3600_000),
              },
            ]
          : [],
      updateMany: jest.fn(async ({ where }: { where: { status: string } }) => {
        if (where.status !== mockPurchaseRow.status) return { count: 0 };
        if (where.status === "PENDING") mockPurchaseRow.status = "FAILED";
        return { count: 1 };
      }),
    },
    recordingPurchase: { findMany: async () => [] },
  },
}));
jest.mock("../../lib/cron/with-cron-lock", () => ({
  withCronLock: (_job: string, _opts: unknown, fn: () => unknown) => fn(),
}));
jest.mock("../../lib/payments/core/razorpay", () => ({
  readRazorpayOrderHolding: (id: string) => mockHolding(id),
  fetchRazorpayOrder: async (id: string) => ({ id, notes: NOTES }),
}));
jest.mock("../../app/api/webhooks/razorpay-dispatch", () => ({
  routeCapturedPayment: async (input: {
    orderId: string;
    notes: Record<string, string>;
    amountPaise: number;
    gatewayPaymentId: string;
    method?: string;
  }) => {
    const { handleDigitalProductPurchaseSuccess } =
      await import("../../lib/payments/webhooks/digital-product-purchase");
    await handleDigitalProductPurchaseSuccess(
      input.orderId,
      input.gatewayPaymentId,
      input.notes,
      input.amountPaise,
      input.method,
    );
  },
}));
jest.mock("../../lib/payments/operations/booking-refund", () => ({
  refundBookingPayment: (...a: unknown[]) => mockRefund(...a),
}));
jest.mock("../../lib/payments/payouts/earnings-service", () => ({
  createEarningsFromPayment: (...a: unknown[]) => mockCreateEarnings(...a),
}));
jest.mock("../../lib/payments/billing/consumer-invoice", () => ({
  mintConsumerInvoiceBestEffort: (...a: unknown[]) => mockMintInvoice(...a),
}));
jest.mock("../../lib/digital-products/purchase-email", () => ({
  prepareDigitalProductReceipt: async (input: { purchaseId: string }) => ({
    purchaseId: input.purchaseId,
  }),
  stageDigitalProductReceipt: (...a: unknown[]) => mockStageReceipt(...a),
  flushDigitalProductReceipt: (...a: unknown[]) => mockFlushReceipt(...a),
  stageOwedDigitalProductReceipts: async () => ({
    checked: 0,
    handled: 0,
    failedIds: [],
  }),
}));
jest.mock("../../lib/observability/report", () => ({
  reportSentryError: jest.fn(),
}));
jest.mock("@sentry/nextjs", () => ({ captureMessage: jest.fn() }));

import {
  handleDigitalProductPurchaseFailure,
  handleDigitalProductPurchaseSuccess,
} from "../../lib/payments/webhooks/digital-product-purchase";
import { reconcileStandalonePurchases } from "../../scripts/payments/reconcile-standalone-purchases";
import { revokeStandaloneSaleEntitlement } from "../../lib/payments/digital-product-entitlement";
import type { Tx } from "../../lib/prisma";

const NOTES = {
  type: "digital_product_purchase",
  productId: "dp-1",
  userId: "u-1",
  originalAmountPaise: "50000",
  taxAmountPaise: "9000",
  buyerCountry: "IN",
};

function purchase(status: string, gatewayPaymentId: string | null = null) {
  return {
    id: "dpp-1",
    productId: "dp-1",
    buyerId: "u-1",
    amountPaise: 59000,
    status,
    gatewayPaymentId,
    product: {
      id: "dp-1",
      consultantProfileId: "cp-1",
      organizationId: null,
      visibility: "PUBLIC",
      status: "PUBLISHED",
      takenDownAt: null,
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockPurchaseRow.status = "PENDING";
  mockPaymentLookup.mockResolvedValue(null);
  mockStageReceipt.mockResolvedValue([{ staged: { id: "fe_1" } }]);
  mockTx.payment.findUnique.mockResolvedValue(null);
  mockTx.digitalProductPurchase.findFirst.mockResolvedValue(null);
  mockTx.digitalProduct.findFirst.mockResolvedValue({ id: "dp-1" });
  mockTx.digitalProductPurchase.updateMany.mockResolvedValue({ count: 1 });
  mockTx.payment.create.mockImplementation(({ data }) =>
    Promise.resolve({ id: `pay-${data.paymentIntent}`, ...data }),
  );
  mockRefund.mockResolvedValue({ refundId: "rf-1" });
});

it("settles a capture atomically and refunds mismatched, duplicate and orphan captures", async () => {
  mockTx.digitalProductPurchase.findUnique.mockResolvedValueOnce(
    purchase("PENDING"),
  );
  await handleDigitalProductPurchaseSuccess(
    "order_1",
    "pay_A",
    NOTES,
    59000,
    "netbanking",
  );
  expect(mockTx.digitalProductPurchase.updateMany).toHaveBeenNthCalledWith(1, {
    where: { id: "dpp-1", status: "PENDING" },
    data: { status: "SUCCEEDED", gatewayPaymentId: "pay_A" },
  });
  expect(mockTx.payment.create.mock.calls[0][0].data).toMatchObject({
    appointmentId: null,
    amount: 59000,
    originalAmount: 50000,
    taxAmount: 9000,
    paymentIntent: "order_1",
    paymentStatus: "SUCCEEDED",
    paymentMethod: "NETBANKING",
    description: "Digital product sale: product dp-1",
    legs: { create: { source: "CARD", amountPaise: 59000 } },
  });
  expect(mockTx.digitalProductPurchase.updateMany).toHaveBeenNthCalledWith(2, {
    where: { id: "dpp-1", paymentId: null },
    data: { paymentId: "pay-order_1" },
  });
  expect(mockCreateEarnings).toHaveBeenCalledWith(
    expect.objectContaining({ appointmentType: "DIGITAL_PRODUCT", tx: mockTx }),
  );
  expect(mockMintInvoice).toHaveBeenCalledWith({ paymentId: "pay-order_1" });
  // The receipt is staged on the settling transaction itself.
  expect(mockStageReceipt).toHaveBeenCalledWith(mockTx, {
    purchaseId: "dpp-1",
  });
  expect(mockFlushReceipt).toHaveBeenCalled();
  expect(mockRefund).not.toHaveBeenCalled();

  // Amount mismatch: staged under the marker, refunded, never granted.
  jest.clearAllMocks();
  mockTx.digitalProductPurchase.findUnique.mockResolvedValueOnce(
    purchase("PENDING"),
  );
  await handleDigitalProductPurchaseSuccess("order_2", "pay_B", NOTES, 100);
  expect(mockTx.digitalProductPurchase.updateMany).not.toHaveBeenCalled();
  expect(mockTx.payment.create.mock.calls[0][0].data.description).toMatch(
    /^Auto-refund pending: capture amount 100p.*Digital product NOT granted\.$/,
  );
  expect(mockRefund).toHaveBeenCalledWith(
    expect.objectContaining({
      dedupeKey: "digital-product-capture:pay-order_2",
    }),
  );
  expect(mockSettleMarker.mock.calls[0][0].data.description).toMatch(
    /^Auto-refunded:/,
  );

  // A second payment on an order already settled by pay_A refunds pay_C only.
  jest.clearAllMocks();
  mockTx.digitalProductPurchase.findUnique.mockResolvedValueOnce(
    purchase("SUCCEEDED", "pay_A"),
  );
  await handleDigitalProductPurchaseSuccess("order_1", "pay_C", NOTES, 59000);
  expect(mockTx.payment.create.mock.calls[0][0].data).toMatchObject({
    paymentIntent: "pay_C",
  });
  expect(mockCreateEarnings).not.toHaveBeenCalled();
  expect(mockStageReceipt).not.toHaveBeenCalled();

  // The purchase row is gone: refund the buyer the notes name.
  jest.clearAllMocks();
  mockTx.digitalProductPurchase.findUnique.mockResolvedValueOnce(null);
  mockTx.user.findUnique.mockResolvedValueOnce({ id: "u-1" });
  await handleDigitalProductPurchaseSuccess("order_9", "pay_D", NOTES, 59000);
  expect(mockTx.payment.create.mock.calls[0][0].data).toMatchObject({
    userId: "u-1",
    paymentIntent: "order_9",
  });
  expect(mockRefund).toHaveBeenCalledTimes(1);
});

it("settles under the product row lock and refunds when the last file was removed first", async () => {
  mockTx.digitalProductPurchase.findUnique.mockResolvedValueOnce(
    purchase("PENDING"),
  );
  mockTx.digitalProduct.findFirst.mockResolvedValueOnce(null);
  await handleDigitalProductPurchaseSuccess("order_1", "pay_A", NOTES, 59000);
  expect(mockTx.$executeRaw).toHaveBeenCalledTimes(1);
  // The purchase stays unsettled; the capture is staged under the marker and refunded.
  expect(mockTx.digitalProductPurchase.updateMany).not.toHaveBeenCalled();
  expect(mockTx.payment.create.mock.calls[0][0].data.description).toMatch(
    /^Auto-refund pending: NO_DELIVERABLE .*Digital product NOT granted\.$/,
  );
  expect(mockRefund).toHaveBeenCalledTimes(1);
  expect(mockCreateEarnings).not.toHaveBeenCalled();
  expect(mockStageReceipt).not.toHaveBeenCalled();

  // A deliverable product: the lock is taken before the purchase CAS.
  jest.clearAllMocks();
  mockTx.digitalProductPurchase.findUnique.mockResolvedValueOnce(
    purchase("PENDING"),
  );
  await handleDigitalProductPurchaseSuccess("order_1", "pay_A", NOTES, 59000);
  expect(mockTx.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
    mockTx.digitalProductPurchase.updateMany.mock.invocationCallOrder[0],
  );
});

it("revokes the digital entitlement by its purchase link, and only then falls back to the replay", async () => {
  const tx = mockTx as unknown as Tx;
  mockTx.digitalProductPurchase.findUnique.mockResolvedValueOnce({
    id: "dpp-1",
  });
  await revokeStandaloneSaleEntitlement(tx, {
    id: "pay-1",
    paymentIntent: "order_1",
  });
  expect(mockTx.digitalProductPurchase.updateMany).toHaveBeenCalledWith({
    where: { paymentId: "pay-1", status: "SUCCEEDED" },
    data: { status: "REFUNDED" },
  });
  expect(mockTx.recordingPurchase.updateMany).not.toHaveBeenCalled();

  mockTx.digitalProductPurchase.findUnique.mockResolvedValueOnce(null);
  await revokeStandaloneSaleEntitlement(tx, {
    id: "pay-2",
    paymentIntent: "order_2",
  });
  expect(mockTx.recordingPurchase.updateMany).toHaveBeenCalledWith({
    where: { gatewayOrderId: "order_2", status: "SUCCEEDED" },
    data: { status: "REFUNDED" },
  });
});

it("keeps the receipt obligation when the process dies after the settling commit", async () => {
  mockTx.digitalProductPurchase.findUnique.mockResolvedValueOnce(
    purchase("PENDING"),
  );
  mockMintInvoice.mockRejectedValueOnce(new Error("process killed"));
  await expect(
    handleDigitalProductPurchaseSuccess("order_1", "pay_A", NOTES, 59000),
  ).rejects.toThrow("process killed");
  // Staged before commit, so the email retry sweep owns delivery from here.
  expect(mockStageReceipt).toHaveBeenCalledWith(mockTx, {
    purchaseId: "dpp-1",
  });
  expect(mockFlushReceipt).not.toHaveBeenCalled();

  // The redelivered webhook short-circuits on the settled Payment and stages nothing new.
  mockPaymentLookup.mockResolvedValueOnce({
    id: "pay-order_1",
    paymentStatus: "SUCCEEDED",
    amount: 59000,
    gatewayPaymentId: "pay_A",
  });
  await handleDigitalProductPurchaseSuccess("order_1", "pay_A", NOTES, 59000);
  expect(mockStageReceipt).toHaveBeenCalledTimes(1);
});

it("recovers a capture on a failed attempt's order when the webhook never arrives", async () => {
  // The first attempt fails on the order; the buyer's retry captures on the same order.
  await handleDigitalProductPurchaseFailure("order_f");
  expect(mockPurchaseRow.status).toBe("FAILED");
  mockHolding.mockResolvedValue({
    kind: "captured",
    paymentId: "pay_R",
    amountPaise: 59000,
    method: "upi",
  });
  mockTx.digitalProductPurchase.findUnique.mockResolvedValueOnce(
    purchase("FAILED"),
  );
  mockTx.digitalProductPurchase.updateMany.mockImplementation(
    async ({ data }: { data: { status?: string } }) => {
      if (data.status === "SUCCEEDED") mockPurchaseRow.status = "SUCCEEDED";
      return { count: 1 };
    },
  );

  const result = await reconcileStandalonePurchases({ limit: 5 });
  expect(result).toMatchObject({ scanned: 1, recovered: 1, errors: 0 });
  expect(mockTx.digitalProductPurchase.updateMany).toHaveBeenCalledWith({
    where: { id: "dpp-1", status: "FAILED" },
    data: { status: "SUCCEEDED", gatewayPaymentId: "pay_R" },
  });
  expect(mockTx.payment.create.mock.calls[0][0].data).toMatchObject({
    paymentIntent: "order_f",
    paymentStatus: "SUCCEEDED",
    paymentMethod: "UPI",
    amount: 59000,
  });
  expect(mockRefund).not.toHaveBeenCalled();
});
