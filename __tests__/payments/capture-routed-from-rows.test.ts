/**
 * @jest-environment node
 */

/**
 * A capture, and a failed attempt, is routed to the rail its order belongs to
 * by the rows the app wrote for that order. The gateway's notes are compared
 * with that answer and never replace it.
 */

jest.mock("@sentry/core", () => jest.requireMock("@sentry/nextjs"));
jest.mock("@sentry/nextjs", () => ({
  setTag: jest.fn(),
  captureException: jest.fn(),
  captureMessage: jest.fn(),
  getCurrentScope: () => ({ setTag: jest.fn() }),
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    fmt: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((acc, s, i) => acc + s + String(values[i] ?? ""), ""),
  },
}));

const handlePaymentSuccess = jest.fn();
const handlePaymentFailure = jest.fn();
const handleOrgPaymentSuccess = jest.fn();
const handleOrgPaymentFailure = jest.fn();
jest.mock("../../app/api/webhooks/utils", () => ({
  __esModule: true,
  handlePaymentSuccess: (...a: unknown[]) => handlePaymentSuccess(...a),
  handlePaymentFailure: (...a: unknown[]) => handlePaymentFailure(...a),
  handleOrgPaymentSuccess: (...a: unknown[]) => handleOrgPaymentSuccess(...a),
  handleOrgPaymentFailure: (...a: unknown[]) => handleOrgPaymentFailure(...a),
  handleRefundCreated: jest.fn(),
  handleDisputeCreated: jest.fn(),
  handleDisputeUpdated: jest.fn(),
  handleRazorpayPayoutWebhook: jest.fn(),
  markWebhookEventProcessed: jest.fn(),
  DeferSignal: class DeferSignal {},
}));

const handleOverageMemberSuccess = jest.fn();
const handleOverageMemberFailure = jest.fn();
jest.mock("../../lib/payments/webhooks/overage-handlers", () => ({
  handleOverageMemberSuccess: (...a: unknown[]) =>
    handleOverageMemberSuccess(...a),
  handleOverageMemberFailure: (...a: unknown[]) =>
    handleOverageMemberFailure(...a),
}));
const handleRecordingPurchaseSuccess = jest.fn();
jest.mock("../../lib/payments/webhooks/recording-purchase", () => ({
  handleRecordingPurchaseSuccess: (...a: unknown[]) =>
    handleRecordingPurchaseSuccess(...a),
  handleRecordingPurchaseFailure: jest.fn(),
}));
const handleDigitalProductPurchaseSuccess = jest.fn();
jest.mock("../../lib/payments/webhooks/digital-product-purchase", () => ({
  handleDigitalProductPurchaseSuccess: (...a: unknown[]) =>
    handleDigitalProductPurchaseSuccess(...a),
  handleDigitalProductPurchaseFailure: jest.fn(),
}));
jest.mock("../../lib/payments/payouts/reverse-penny-drop", () => ({
  handleFundAccountValidationWebhook: jest.fn(),
}));
jest.mock("../../lib/payments/core/razorpay", () => ({
  getRazorpayClient: () => null,
  withRazorpaySdkTimeout: (_op: string, call: () => unknown) => call(),
}));
jest.mock("../../lib/payments/ledger/gateway-fee", () => ({
  postGatewayFee: jest.fn(),
}));
jest.mock("../../lib/payments/payer-instruments", () => ({
  recordPayerInstruments: jest.fn(),
}));
const reportSentryMessage = jest.fn();
jest.mock("../../lib/observability/report", () => ({
  reportSentryError: jest.fn(),
  reportSentryMessage: (...a: unknown[]) => reportSentryMessage(...a),
  errorMessageOf: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));
const paymentRow = jest.fn();
const recordingRow = jest.fn();
const digitalRow = jest.fn();
const invoiceRow = jest.fn();
const topUpRows = jest.fn();
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    payment: { findUnique: (...a: unknown[]) => paymentRow(...a) },
    recordingPurchase: { findUnique: (...a: unknown[]) => recordingRow(...a) },
    digitalProductPurchase: {
      findUnique: (...a: unknown[]) => digitalRow(...a),
    },
    organizationInvoice: { findFirst: (...a: unknown[]) => invoiceRow(...a) },
    walletTopUp: { findMany: (...a: unknown[]) => topUpRows(...a) },
    webhookEvent: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
  },
}));

import {
  processRazorpayWebhookEvent,
  routeCapturedPayment,
} from "../../app/api/webhooks/razorpay-dispatch";

const ORDER = "order_TestOrder00001";
const PAY = "pay_TestPay0000001";

/** A capture as a door hands it over; the notes default to what an empty payment entity carries. */
const capture = (notes: Record<string, string> = {}) =>
  routeCapturedPayment({
    orderId: ORDER,
    notes,
    amountPaise: 50_000,
    gatewayPaymentId: PAY,
  });

beforeEach(() => {
  jest.clearAllMocks();
  paymentRow.mockResolvedValue(null);
  recordingRow.mockResolvedValue(null);
  digitalRow.mockResolvedValue(null);
  invoiceRow.mockResolvedValue(null);
  topUpRows.mockResolvedValue([]);
});

describe("a capture whose payment carries no notes", () => {
  it("settles an overage side payment on the overage rail", async () => {
    paymentRow.mockResolvedValue({ parentPaymentId: "pay-parent" });

    await capture();

    expect(handleOverageMemberSuccess).toHaveBeenCalledWith(ORDER, 50_000, PAY);
    expect(handlePaymentSuccess).not.toHaveBeenCalled();
  });

  it("credits a wallet top-up from its own row", async () => {
    topUpRows.mockResolvedValue([
      {
        providerOrderId: "we_1",
        amountPaise: 50_000,
        notes: `Top-up initiated by membership m1; razorpay_order=${ORDER}`,
        billingAccountId: "ba-1",
        billingAccount: { ownerOrgId: "org-1" },
      },
    ]);

    await capture();

    expect(handleOrgPaymentSuccess).toHaveBeenCalledWith(
      {
        type: "credit_purchase",
        walletEntryOrderId: "we_1",
        organizationId: "org-1",
        billingAccountId: "ba-1",
        amountPaise: "50000",
      },
      PAY,
      50_000,
    );
    expect(handlePaymentSuccess).not.toHaveBeenCalled();
  });

  it("does not match a top-up whose minted order only shares the prefix", async () => {
    topUpRows.mockResolvedValue([
      {
        providerOrderId: "we_other",
        amountPaise: 50_000,
        notes: `razorpay_order=${ORDER}X`,
        billingAccountId: "ba-1",
        billingAccount: { ownerOrgId: "org-1" },
      },
    ]);

    await capture();

    expect(handleOrgPaymentSuccess).not.toHaveBeenCalled();
    expect(handlePaymentSuccess).toHaveBeenCalled();
  });

  it("pays an organisation invoice from the invoice that minted the order", async () => {
    invoiceRow.mockResolvedValue({ id: "inv-1", organizationId: "org-1" });

    await capture();

    expect(invoiceRow).toHaveBeenCalledWith(
      expect.objectContaining({ where: { providerPaymentOrderId: ORDER } }),
    );
    expect(handleOrgPaymentSuccess).toHaveBeenCalledWith(
      { type: "invoice_payment", invoiceId: "inv-1", organizationId: "org-1" },
      PAY,
      50_000,
    );
  });

  it("settles a replay purchase even though its capture left a Payment row under the same order", async () => {
    recordingRow.mockResolvedValue({ id: "rp-1" });
    paymentRow.mockResolvedValue({ parentPaymentId: null });

    await capture();

    expect(handleRecordingPurchaseSuccess).toHaveBeenCalledWith(
      ORDER,
      PAY,
      {},
      50_000,
      undefined,
    );
    expect(handlePaymentSuccess).not.toHaveBeenCalled();
  });

  it("confirms a booking payment through the one booking writer", async () => {
    paymentRow.mockResolvedValue({ parentPaymentId: null });

    await capture();

    expect(handlePaymentSuccess).toHaveBeenCalledWith(ORDER, {}, 50_000, PAY);
  });
});

describe("the gateway's own time for the payment", () => {
  const PAID_AT_SECONDS = 1_764_000_000;

  it("rides from the door to the booking writer", async () => {
    paymentRow.mockResolvedValue({ parentPaymentId: null });
    const gatewayCapturedAt = new Date(PAID_AT_SECONDS * 1000);

    await routeCapturedPayment({
      orderId: ORDER,
      notes: {},
      amountPaise: 50_000,
      gatewayPaymentId: PAY,
      gatewayCapturedAt,
    });

    expect(handlePaymentSuccess).toHaveBeenCalledWith(ORDER, {}, 50_000, PAY, {
      gatewayCapturedAt,
    });
  });

  it("is read off the payment entity of a payment.captured event", async () => {
    paymentRow.mockResolvedValue({ parentPaymentId: null });

    await processRazorpayWebhookEvent(
      {
        entity: "event",
        account_id: "acc_1",
        event: "payment.captured",
        contains: ["payment"],
        created_at: PAID_AT_SECONDS + 500,
        payload: {
          payment: {
            entity: {
              id: PAY,
              amount: 50_000,
              currency: "INR",
              status: "captured",
              order_id: ORDER,
              notes: [],
              created_at: PAID_AT_SECONDS,
            },
          },
        },
      },
      "payment.captured",
      "evt-captured",
    );

    expect(handlePaymentSuccess).toHaveBeenCalledWith(ORDER, {}, 50_000, PAY, {
      gatewayCapturedAt: new Date(PAID_AT_SECONDS * 1000),
    });
  });
});

describe("notes that disagree with the order's row", () => {
  it("the row wins and the disagreement is reported once", async () => {
    paymentRow.mockResolvedValue({ parentPaymentId: null });

    await capture({ type: "credit_purchase", walletEntryOrderId: "we_forged" });

    expect(handlePaymentSuccess).toHaveBeenCalled();
    expect(handleOrgPaymentSuccess).not.toHaveBeenCalled();
    expect(reportSentryMessage).toHaveBeenCalledTimes(1);
    expect(reportSentryMessage).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        extra: {
          orderId: ORDER,
          rowRail: "booking",
          notesRail: "wallet_top_up",
        },
      }),
    );
  });

  it("notes that agree with the row report nothing", async () => {
    paymentRow.mockResolvedValue({ parentPaymentId: "pay-parent" });

    await capture({ type: "overage_member" });

    expect(handleOverageMemberSuccess).toHaveBeenCalled();
    expect(reportSentryMessage).not.toHaveBeenCalled();
  });
});

describe("a replaced overage order's tombstone", () => {
  it("goes to the booking writer, which refunds it, with or without notes and with no conflict report", async () => {
    paymentRow.mockResolvedValue({ parentPaymentId: null });

    await capture({ type: "overage_member" });
    await capture();

    expect(handlePaymentSuccess).toHaveBeenCalledTimes(2);
    expect(handleOverageMemberSuccess).not.toHaveBeenCalled();
    expect(reportSentryMessage).not.toHaveBeenCalled();
  });
});

describe("an order no row names", () => {
  it("keeps the standalone sale's own orphan handling when the notes name it", async () => {
    const notes = { type: "digital_product_purchase", userId: "u-1" };

    await capture(notes);

    expect(handleDigitalProductPurchaseSuccess).toHaveBeenCalledWith(
      ORDER,
      PAY,
      notes,
      50_000,
      undefined,
    );
  });

  it("otherwise goes to the booking writer, which adopts or refuses it", async () => {
    await capture();

    expect(handlePaymentSuccess).toHaveBeenCalledWith(ORDER, {}, 50_000, PAY);
  });
});

describe("a failed attempt whose payment carries no notes", () => {
  const failed = () =>
    processRazorpayWebhookEvent(
      {
        entity: "event",
        account_id: "acc_1",
        event: "payment.failed",
        contains: ["payment"],
        created_at: 1,
        payload: {
          payment: {
            entity: {
              id: PAY,
              amount: 50_000,
              currency: "INR",
              status: "failed",
              order_id: ORDER,
              notes: [],
            },
          },
        },
      },
      "payment.failed",
      "evt-failed",
    );

  it("fails an overage side payment on the overage rail", async () => {
    paymentRow.mockResolvedValue({ parentPaymentId: "pay-parent" });

    await failed();

    expect(handleOverageMemberFailure).toHaveBeenCalledWith(ORDER);
    expect(handlePaymentFailure).not.toHaveBeenCalled();
  });

  it("records a wallet top-up failure against the top-up row", async () => {
    topUpRows.mockResolvedValue([
      {
        providerOrderId: "we_1",
        amountPaise: 50_000,
        notes: `razorpay_order=${ORDER}`,
        billingAccountId: "ba-1",
        billingAccount: { ownerOrgId: "org-1" },
      },
    ]);

    await failed();

    expect(handleOrgPaymentFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "credit_purchase",
        walletEntryOrderId: "we_1",
      }),
      PAY,
    );
    expect(handlePaymentFailure).not.toHaveBeenCalled();
  });
});
