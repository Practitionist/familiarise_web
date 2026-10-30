/**
 * A digital product capture either settles its purchase atomically (purchase,
 * Payment, CARD leg, purchase link, earnings) or is staged under the
 * auto-refund marker and refunded after commit; a full refund revokes the
 * entitlement by its explicit purchase link, never by "appointment-less".
 */
const mockTx = {
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
const mockNotifyPurchase = jest.fn();

jest.mock("../../lib/payments/ledger/unapplied-receipts", () => ({
  postUnappliedReceipt: jest.fn(),
}));
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    $transaction: (cb: (tx: typeof mockTx) => Promise<unknown>) => cb(mockTx),
    payment: {
      findUnique: jest.fn().mockResolvedValue(null),
      updateMany: (...a: unknown[]) => mockSettleMarker(...a),
    },
    digitalProductPurchase: { updateMany: jest.fn() },
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
  notifyDigitalProductPurchase: (...a: unknown[]) => mockNotifyPurchase(...a),
}));
jest.mock("../../lib/observability/report", () => ({
  reportSentryError: jest.fn(),
}));
jest.mock("@sentry/nextjs", () => ({ captureMessage: jest.fn() }));

import { handleDigitalProductPurchaseSuccess } from "../../lib/payments/webhooks/digital-product-purchase";
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
  mockTx.payment.findUnique.mockResolvedValue(null);
  mockTx.digitalProductPurchase.findFirst.mockResolvedValue(null);
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
  await handleDigitalProductPurchaseSuccess("order_1", "pay_A", NOTES, 59000);
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
  expect(mockNotifyPurchase).toHaveBeenCalledWith(
    { paymentId: "pay-order_1" },
    expect.any(Number),
  );
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
  expect(mockNotifyPurchase).not.toHaveBeenCalled();

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
