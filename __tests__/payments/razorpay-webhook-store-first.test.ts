/**
 * @jest-environment node
 */

/**
 * A signed Razorpay delivery is stored before anything validates its shape,
 * and a shape the handlers cannot read ends as an error on that stored row,
 * never as a 400 the gateway retries.
 */

const afterCallbacks: Array<() => unknown> = [];
jest.mock("next/server", () => ({
  ...jest.requireActual("next/server"),
  after: (cb: () => unknown) => {
    afterCallbacks.push(cb);
  },
}));

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

const logWebhookEvent = jest.fn();
const markWebhookEventProcessed = jest.fn();
const handleRefundCreated = jest.fn();
const handlePaymentSuccess = jest.fn();
jest.mock("../../app/api/webhooks/utils", () => ({
  __esModule: true,
  logWebhookEvent: (...a: unknown[]) => logWebhookEvent(...a),
  isDbHealthy: jest.fn().mockResolvedValue(true),
  markWebhookEventProcessed: (...a: unknown[]) =>
    markWebhookEventProcessed(...a),
  handleRefundCreated: (...a: unknown[]) => handleRefundCreated(...a),
  handlePaymentSuccess: (...a: unknown[]) => handlePaymentSuccess(...a),
  handlePaymentFailure: jest.fn(),
  handleOrgPaymentSuccess: jest.fn(),
  handleOrgPaymentFailure: jest.fn(),
  handleDisputeCreated: jest.fn(),
  handleDisputeUpdated: jest.fn(),
  handleRazorpayPayoutWebhook: jest.fn(),
  DeferSignal: class DeferSignal {},
}));

jest.mock("../../app/api/webhooks/razorpay/signature", () => ({
  isPayoutEventName: jest.fn().mockReturnValue(false),
  matchRazorpayWebhookSecret: jest.fn().mockReturnValue("current"),
  resolveRazorpayPaymentSecrets: jest.fn().mockReturnValue(["secret"]),
  resolveRazorpayXSecrets: jest.fn().mockReturnValue([]),
}));

jest.mock("../../lib/enterprise/system-events", () => ({
  recordSystemEvent: jest.fn(),
  recordSystemEventSafe: jest.fn(),
}));
const reportSentryError = jest.fn();
jest.mock("../../lib/observability/report", () => ({
  reportSentryError: (...a: unknown[]) => reportSentryError(...a),
  reportSentryMessage: jest.fn(),
  errorMessageOf: (e: unknown) => (e instanceof Error ? e.message : String(e)),
}));
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    payment: { findFirst: jest.fn().mockResolvedValue(null) },
    webhookEvent: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
  },
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
jest.mock("../../lib/payments/webhooks/overage-handlers", () => ({
  handleOverageMemberSuccess: jest.fn(),
  handleOverageMemberFailure: jest.fn(),
}));
jest.mock("../../lib/payments/webhooks/recording-purchase", () => ({
  handleRecordingPurchaseSuccess: jest.fn(),
  handleRecordingPurchaseFailure: jest.fn(),
}));
jest.mock("../../lib/payments/webhooks/digital-product-purchase", () => ({
  handleDigitalProductPurchaseSuccess: jest.fn(),
  handleDigitalProductPurchaseFailure: jest.fn(),
}));
jest.mock("../../lib/payments/payouts/reverse-penny-drop", () => ({
  handleFundAccountValidationWebhook: jest.fn(),
}));
jest.mock("../../lib/payments/webhooks/capture-rail", () => ({
  ...jest.requireActual("../../lib/payments/webhooks/capture-rail"),
  resolveCaptureRail: jest.fn(async () => ({ rail: "booking" })),
}));

import * as Sentry from "@sentry/nextjs";
import type { NextRequest } from "next/server";
import prisma from "../../lib/prisma";
import { POST } from "../../app/api/webhooks/razorpay/route";
import { processRazorpayWebhookEvent } from "../../app/api/webhooks/razorpay-dispatch";

const CLAIM = { claimedAt: null };

function signed(body: string, eventId = "evt_1") {
  const headers = new Headers({
    "content-length": String(body.length),
    "x-razorpay-signature": "sig",
    "x-razorpay-event-id": eventId,
  });
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    },
  });
  return { headers, body: stream } as unknown as NextRequest;
}

const refundEntity = (over: Record<string, unknown> = {}) => ({
  id: "rfnd_1",
  payment_id: "pay_1",
  amount: 50000,
  currency: "INR",
  status: "processed",
  notes: {},
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  afterCallbacks.length = 0;
  logWebhookEvent.mockResolvedValue({ isNew: true, claim: CLAIM });
  markWebhookEventProcessed.mockResolvedValue(undefined);
});

describe("the route stores a signed event before it reads its shape", () => {
  it("stores and acknowledges a refund whose speed is a value the app has never seen", async () => {
    const payload = {
      refund: { entity: refundEntity({ speed_processed: "turbo" }) },
    };
    const res = await POST(
      signed(JSON.stringify({ event: "refund.processed", payload })),
    );

    expect(res.status).toBe(200);
    expect(logWebhookEvent).toHaveBeenCalledWith(
      "razorpay",
      "refund.processed:rfnd_1:evt_1",
      "refund.processed",
      payload,
      "sig",
    );
  });

  it("stores and acknowledges a dispute whose deduct_at_onset is not a boolean", async () => {
    const payload = {
      dispute: { entity: { id: "disp_1", deduct_at_onset: "yes" } },
    };
    const res = await POST(
      signed(JSON.stringify({ event: "payment.dispute.created", payload })),
    );

    expect(res.status).toBe(200);
    expect(logWebhookEvent).toHaveBeenCalledWith(
      "razorpay",
      "payment.dispute.created:disp_1:evt_1",
      "payment.dispute.created",
      payload,
      "sig",
    );
  });

  it("stores a signed body with no event name whole, under the unreadable type", async () => {
    const raw = { payload: { payment: { entity: { id: "pay_9" } } } };
    const res = await POST(signed(JSON.stringify(raw)));

    expect(res.status).toBe(200);
    expect(logWebhookEvent).toHaveBeenCalledWith(
      "razorpay",
      expect.stringMatching(/^unreadable:body_[0-9a-f]{16}:evt_1$/),
      "unreadable",
      raw,
      "sig",
    );
  });

  it("stores a signed body that is not JSON as its text", async () => {
    const res = await POST(signed("not json"));

    expect(res.status).toBe(200);
    expect(logWebhookEvent).toHaveBeenCalledWith(
      "razorpay",
      expect.stringMatching(/^unreadable:body_/),
      "unreadable",
      "not json",
      "sig",
    );
  });

  it("hands dispatch the raw event, so a parse failure lands on the stored row", async () => {
    const raw = { event: "payment.captured", payload: { payment: 7 } };
    await POST(signed(JSON.stringify(raw)));
    expect(afterCallbacks).toHaveLength(1);
    await afterCallbacks[0]();

    expect(markWebhookEventProcessed).toHaveBeenCalledWith(
      expect.stringMatching(/^payment\.captured:/),
      expect.stringMatching(/^schema mismatch: payment\.captured/),
      CLAIM,
    );
  });
});

describe("a redelivery that reclaims a stored event", () => {
  const unreadable = { event: "payment.captured", payload: { payment: 7 } };

  it("counts the money event's retry window from when the row was first stored", async () => {
    logWebhookEvent.mockResolvedValue({
      isNew: true,
      claim: CLAIM,
      receivedAt: new Date(Date.now() - 25 * 3_600_000),
    });

    await POST(signed(JSON.stringify(unreadable)));
    await afterCallbacks[0]();

    expect(markWebhookEventProcessed).toHaveBeenCalledWith(
      expect.stringMatching(/^payment\.captured:/),
      expect.stringMatching(/^permanent: schema mismatch: payment\.captured/),
      CLAIM,
    );
  });

  it("stays quiet about a shape it already reported while the window is open", async () => {
    logWebhookEvent.mockResolvedValue({
      isNew: true,
      claim: CLAIM,
      receivedAt: new Date(Date.now() - 3_600_000),
    });

    await POST(signed(JSON.stringify(unreadable)));
    await afterCallbacks[0]();

    expect(markWebhookEventProcessed).toHaveBeenCalledWith(
      expect.stringMatching(/^payment\.captured:/),
      expect.stringMatching(/^schema mismatch: payment\.captured/),
      CLAIM,
    );
    expect(reportSentryError).not.toHaveBeenCalled();
  });
});

describe("dispatch parses each event's entity itself", () => {
  it("imports a refund whose speed is a value the app has never seen", async () => {
    await processRazorpayWebhookEvent(
      {
        event: "refund.processed",
        payload: {
          refund: { entity: refundEntity({ speed_processed: "turbo" }) },
          payment: { entity: { id: "pay_1", order_id: "order_1" } },
        },
      },
      "refund.processed",
      "evt-refund",
      CLAIM,
    );

    expect(handleRefundCreated).toHaveBeenCalledWith(
      "rfnd_1",
      "order_1",
      50000,
      "INR",
      "processed",
      "pay_1",
      {},
      // The embedded payment says nothing about its capture.
      undefined,
    );
    expect(markWebhookEventProcessed).toHaveBeenCalledWith(
      "evt-refund",
      undefined,
      CLAIM,
    );
  });

  const unreadableCapture = {
    event: "payment.captured",
    payload: { payment: { entity: { id: "pay_1", order_id: "order_1" } } },
  };

  it("keeps a money event with an unreadable shape retryable while it is fresh", async () => {
    await processRazorpayWebhookEvent(
      unreadableCapture,
      "payment.captured",
      "evt-capture",
      CLAIM,
    );

    const [, error] = markWebhookEventProcessed.mock.calls[0];
    expect(error).toMatch(/^schema mismatch: payment\.captured/);
    expect(handlePaymentSuccess).not.toHaveBeenCalled();
    // Reported once, on the delivery that first met it.
    expect(reportSentryError).toHaveBeenCalledTimes(1);
  });

  it("stays quiet while the sweeper re-drives it inside the retry window", async () => {
    await processRazorpayWebhookEvent(
      unreadableCapture,
      "payment.captured",
      "evt-capture",
      CLAIM,
      new Date(Date.now() - 3_600_000),
    );

    const [, error] = markWebhookEventProcessed.mock.calls[0];
    expect(error).toMatch(/^schema mismatch:/);
    expect(reportSentryError).not.toHaveBeenCalled();
  });

  it("marks it permanent once the retry window has passed", async () => {
    await processRazorpayWebhookEvent(
      unreadableCapture,
      "payment.captured",
      "evt-capture",
      CLAIM,
      new Date(Date.now() - 25 * 3_600_000),
    );

    const [, error] = markWebhookEventProcessed.mock.calls[0];
    expect(error).toMatch(/^permanent: schema mismatch: payment\.captured/);
    expect(reportSentryError).toHaveBeenCalledTimes(1);
  });

  it("marks an unreadable event that moves no money permanent at once", async () => {
    await processRazorpayWebhookEvent(
      { payload: {} },
      "unreadable",
      "evt-unreadable",
      CLAIM,
    );

    const [, error] = markWebhookEventProcessed.mock.calls[0];
    expect(error).toMatch(/^permanent: schema mismatch: unreadable/);
  });
});

describe("a capture another door is confirming", () => {
  const capturedEvent = {
    entity: "event",
    account_id: "acc_test",
    event: "payment.captured",
    contains: ["payment"],
    payload: {
      payment: {
        entity: {
          id: "pay_locked_1",
          entity: "payment",
          amount: 50000,
          currency: "INR",
          status: "captured",
          order_id: "order_locked_1",
          method: "upi",
          captured: true,
          notes: { type: "booking" },
          created_at: 1_700_000_000,
        },
      },
    },
    created_at: 1_700_000_000,
  };

  it("defers the event for the sweeper instead of recording or reporting a failure", async () => {
    handlePaymentSuccess.mockRejectedValueOnce(
      Object.assign(new Error("canceling statement due to lock timeout"), {
        name: "DriverAdapterError",
        cause: { kind: "postgres", code: "55P03", originalCode: "55P03" },
      }),
    );

    await processRazorpayWebhookEvent(
      capturedEvent,
      "payment.captured",
      "evt-locked",
      CLAIM,
    );

    expect(handlePaymentSuccess).toHaveBeenCalledTimes(1);
    expect(markWebhookEventProcessed).not.toHaveBeenCalled();
    expect(jest.mocked(prisma.webhookEvent.updateMany)).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ eventId: "evt-locked" }),
        data: { deferCount: { increment: 1 } },
      }),
    );
    expect(jest.mocked(Sentry.captureException)).not.toHaveBeenCalled();
    expect(reportSentryError).not.toHaveBeenCalled();
  });
});
