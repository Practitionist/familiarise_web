/**
 * Every captured rupee on a replay order either fulfils a purchase or is
 * refunded: a late retry re-grants, an unpurchasable replay and a duplicate
 * charge are staged under the auto-refund marker and refunded after commit.
 */
const mockTx = {
  recordingPurchase: {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    updateMany: jest.fn(),
  },
  payment: { findUnique: jest.fn(), create: jest.fn() },
};
const mockSettleMarker = jest.fn();
const mockRefund = jest.fn();
const mockCreateEarnings = jest.fn();
const mockMintInvoice = jest.fn();

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    $transaction: (cb: (tx: typeof mockTx) => Promise<unknown>) => cb(mockTx),
    payment: { updateMany: (...a: unknown[]) => mockSettleMarker(...a) },
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
jest.mock("../../lib/observability/report", () => ({
  reportSentryError: jest.fn(),
}));
jest.mock("@sentry/nextjs", () => ({ captureMessage: jest.fn() }));

import { handleRecordingPurchaseSuccess } from "../../lib/payments/webhooks/recording-purchase";

function purchase(
  status: string,
  listingStatus = "PUBLISHED",
  gatewayPaymentId: string | null = null,
) {
  return {
    id: "rp-1",
    recordingId: "rec-1",
    buyerId: "u-1",
    amountPaise: BigInt(99900),
    status,
    gatewayPaymentId,
    recording: {
      id: "rec-1",
      organizationId: null,
      listingStatus,
      status: "AVAILABLE",
      storageType: "PLATFORM",
      meeting: {
        occurrence: {
          appointment: {
            organizationId: null,
            webinar: {
              webinarPlanId: "wp-1",
              webinarPlan: {
                id: "wp-1",
                consultantProfileId: "cp-1",
                organizationId: null,
              },
            },
            class: null,
            consultation: null,
            subscription: null,
          },
        },
      },
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockTx.payment.findUnique.mockResolvedValue(null);
  mockTx.recordingPurchase.findFirst.mockResolvedValue(null);
  mockTx.payment.create.mockImplementation(({ data }) =>
    Promise.resolve({ id: `pay-${data.paymentIntent}`, ...data }),
  );
  mockRefund.mockResolvedValue({ refundId: "rf-1" });
});

it("re-grants a late retry, refunds an unpurchasable replay and refunds a duplicate charge", async () => {
  // Late retry on a FAILED order while the replay is still listed: re-grant.
  mockTx.recordingPurchase.findUnique.mockResolvedValueOnce(purchase("FAILED"));
  mockTx.recordingPurchase.updateMany.mockResolvedValueOnce({ count: 1 });
  await handleRecordingPurchaseSuccess("order_1", "pay_B", {}, 99900);
  expect(mockTx.recordingPurchase.updateMany).toHaveBeenCalledWith({
    where: { id: "rp-1", status: "FAILED" },
    data: { status: "SUCCEEDED", gatewayPaymentId: "pay_B" },
  });
  expect(mockTx.payment.create.mock.calls[0][0].data).toMatchObject({
    amount: 99900,
    paymentIntent: "order_1",
    paymentStatus: "SUCCEEDED",
  });
  expect(mockCreateEarnings).toHaveBeenCalledTimes(1);
  expect(mockMintInvoice).toHaveBeenCalledWith({ paymentId: "pay-order_1" });
  expect(mockRefund).not.toHaveBeenCalled();

  // Late retry after the replay was unpublished: stage and refund the capture.
  jest.clearAllMocks();
  mockTx.recordingPurchase.findUnique.mockResolvedValueOnce(
    purchase("FAILED", "UNPUBLISHED"),
  );
  await handleRecordingPurchaseSuccess("order_2", "pay_C", {}, 99900);
  expect(mockTx.recordingPurchase.updateMany).not.toHaveBeenCalled();
  expect(mockCreateEarnings).not.toHaveBeenCalled();
  const staged = mockTx.payment.create.mock.calls[0][0].data;
  expect(staged).toMatchObject({ paymentIntent: "order_2", amount: 99900 });
  expect(staged.description).toMatch(/^Auto-refund pending:/);
  expect(mockRefund).toHaveBeenCalledWith(
    expect.objectContaining({
      paymentId: "pay-order_2",
      dedupeKey: "replay-capture:pay-order_2",
    }),
  );
  expect(mockSettleMarker.mock.calls[0][0].data.description).toMatch(
    /^Auto-refunded:/,
  );

  // A second payment on an order already settled by pay_A: refund pay_D only.
  jest.clearAllMocks();
  mockTx.recordingPurchase.findUnique.mockResolvedValueOnce(
    purchase("SUCCEEDED", "PUBLISHED", "pay_A"),
  );
  await handleRecordingPurchaseSuccess("order_3", "pay_D", {}, 99900);
  expect(mockTx.payment.create.mock.calls[0][0].data).toMatchObject({
    paymentIntent: "pay_D",
    gatewayPaymentId: "pay_D",
  });
  expect(mockRefund).toHaveBeenCalledWith(
    expect.objectContaining({ paymentId: "pay-pay_D" }),
  );
  expect(mockCreateEarnings).not.toHaveBeenCalled();
});
