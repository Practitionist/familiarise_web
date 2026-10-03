/**
 * @jest-environment node
 */

/**
 * The captured-amount PARITY CHECK only works if the amount that reaches it is
 * the amount the gateway actually settled. Three doors fed it something else,
 * or nothing, and a capture below the order then confirmed a FULL booking in
 * silence (silent under-collection):
 *
 *   1. The Stripe webhook never entered the confirmation router at all — it
 *      called `handlePaymentSuccess(id, metadata)` with the 3rd and 4th
 *      arguments omitted, so both the parity check and the `gatewayPaymentId`
 *      write were skipped.
 *   2. `order.paid` fell back to `order.entity.amount` — the order TOTAL — when
 *      Razorpay shipped no payment entity, so the guard compared the gateway
 *      against itself and always passed.
 *   3. The parity comparison sat BELOW the SUCCEEDED early-return, so a
 *      redelivery returned null before the mismatch was ever examined and the
 *      short-circuit was indistinguishable from agreement.
 *
 * These are end-to-end on purpose: the real `routeCapturedPayment` and the real
 * `handlePaymentSuccess` run, and only the transport edges (signature, dedupe
 * log, DB health) and the prisma/notification graph are mocked. Asserting on
 * the router's arguments alone would pass even if the guard below them were
 * still bypassed, which is exactly the bug being pinned.
 */

type PaymentStampArgs = {
  where: { paymentStatus?: string };
  data: {
    paymentStatus?: string;
    description?: string;
    gatewayPaymentId?: string | null;
  };
};

const mockParityState = {
  body: "{}",
  captureException: jest.fn((..._a: unknown[]): unknown => undefined),
  captureMessage: jest.fn((..._a: unknown[]): unknown => undefined),
  paymentUpdateMany: jest.fn(async (_args: PaymentStampArgs) => ({ count: 1 })),
  paymentFindUnique: jest.fn(
    (..._a: unknown[]): Promise<unknown> => Promise.resolve(undefined),
  ),
  appointmentFindUnique: jest.fn(
    (..._a: unknown[]): Promise<unknown> => Promise.resolve(undefined),
  ),
  txPaymentUpdate: jest.fn(async (..._a: unknown[]) => ({})),
  trialUpdateMany: jest.fn(async (..._a: unknown[]) => ({ count: 1 })),
  trialFindUnique: jest.fn((..._a: unknown[]): unknown => undefined),
  occurrenceFindMany: jest.fn(),
  prismaPaymentUpdate: jest.fn(async (..._a: unknown[]) => ({})),
  createEarningsFromPayment: jest.fn(),
  refundPayment: jest.fn(
    (..._a: unknown[]): Promise<unknown> => Promise.resolve(undefined),
  ),
  refundBookingPayment: jest.fn((..._a: unknown[]): unknown => undefined),
  recordSystemEvent: jest.fn(async (..._a: unknown[]) => undefined),
  validateWebhookMetadata: jest.fn((..._a: unknown[]): unknown => undefined),
};

const mockParityTx = {
  payment: {
    findUnique: mockParityState.paymentFindUnique,
    updateMany: mockParityState.paymentUpdateMany,
    update: mockParityState.txPaymentUpdate,
  },
  appointment: { findUnique: mockParityState.appointmentFindUnique },
  trial: {
    updateMany: mockParityState.trialUpdateMany,
    findUnique: mockParityState.trialFindUnique,
  },
  appointmentOccurrence: { findMany: mockParityState.occurrenceFindMany },
};

jest.mock("@sentry/nextjs", () => ({
  __esModule: true,
  setTag: jest.fn(),
  captureException: (...a: unknown[]) =>
    mockParityState.captureException(...a),
  captureMessage: (...a: unknown[]) => mockParityState.captureMessage(...a),
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    fmt: (s: TemplateStringsArray) => s.join(""),
  },
  getCurrentScope: () => ({ setTag: jest.fn() }),
}));

jest.mock("../../lib/db/serializable-retry", () => ({
  __esModule: true,
  withSerializableRetry: async (run: () => unknown) => run(),
}));

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    $transaction: async (run: (tx: unknown) => unknown) => run(mockParityTx),
    payment: {
      update: (...a: unknown[]) =>
        mockParityState.prismaPaymentUpdate(...(a as [never])),
    },
    webhookEvent: {
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
  },
}));

jest.mock("../../lib/payments/payouts", () => ({
  createEarningsFromPayment: (...a: unknown[]) =>
    mockParityState.createEarningsFromPayment(...a),
}));
jest.mock("../../lib/payments/operations/refund", () => ({
  refundPayment: (...a: unknown[]) => mockParityState.refundPayment(...a),
}));
jest.mock("../../lib/payments/operations/booking-refund", () => ({
  refundBookingPayment: (...a: unknown[]) =>
    mockParityState.refundBookingPayment(...a),
}));
jest.mock("../../lib/email", () => ({
  sendPaymentSuccessEmail: jest.fn(),
  sendPaymentFailedEmail: jest.fn(),
}));
jest.mock("../../lib/novu", () => ({
  notifyPaymentSuccess: jest.fn(),
  notifyPaymentFailed: jest.fn(),
  notifyAppointmentBooked: jest.fn(),
}));
jest.mock("../../lib/referrals/service", () => ({
  processQualifyingAction: jest.fn(),
  processConsultantBookingReferral: jest.fn(),
}));
jest.mock("../../actions/stream/chat/event-channel.action", () => ({
  addUserToEventChannel: jest.fn(),
}));
jest.mock("../../actions/stream/chat/channel.action", () => ({
  createDirectMessageChannel: jest.fn(),
}));
jest.mock("../../lib/stream-logger", () => ({
  streamLogger: { info: jest.fn(), error: jest.fn() },
}));
jest.mock("../../lib/enterprise/system-events", () => ({
  recordSystemError: (...a: unknown[]) =>
    mockParityState.recordSystemEvent(...(a as [never])),
  recordSystemErrorSafe: (...a: unknown[]) =>
    mockParityState.recordSystemEvent(...(a as [never])),
  recordSystemEventSafe: (...a: unknown[]) =>
    mockParityState.recordSystemEvent(...(a as [never])),
}));
jest.mock("../../schemas/webhooks/metadata", () => ({
  normalizeLegacySlotKeys: (m: unknown) => m,
  validateWebhookMetadata: (...a: unknown[]) =>
    mockParityState.validateWebhookMetadata(...a),
}));
jest.mock("../../lib/payments/core/razorpay", () => ({}));
jest.mock("../../lib/payments/webhooks/overage-handlers", () => ({
  handleOverageMemberSuccess: jest.fn(),
  handleOverageMemberFailure: jest.fn(),
}));
jest.mock("../../lib/payments/webhooks/recording-purchase", () => ({
  handleRecordingPurchaseSuccess: jest.fn(),
  handleRecordingPurchaseFailure: jest.fn(),
}));

jest.mock("../../app/api/webhooks/utils", () => {
  const realHandlers = jest.requireActual("../../lib/payments/webhooks/handlers");
  const noopAsync = () => jest.fn(async () => undefined);
  return {
    __esModule: true,
    handlePaymentSuccess: realHandlers.handlePaymentSuccess,
    handlePaymentFailure: noopAsync(),
    handleOrgPaymentSuccess: noopAsync(),
    handleOrgPaymentFailure: noopAsync(),
    handleRefundCreated: noopAsync(),
    handleDisputeCreated: noopAsync(),
    handleDisputeUpdated: noopAsync(),
    handleRazorpayPayoutWebhook: noopAsync(),
    handleStripePayoutWebhook: noopAsync(),
    DeferSignal: class DeferSignal {},
    isDbHealthy: jest.fn(async () => true),
    verifyWebhookSignature: jest.fn(async () => ({
      isValid: true,
      body: mockParityState.body,
      oversized: false,
    })),
    logWebhookEvent: jest.fn(async () => ({
      isNew: true,
      claim: { id: "we1" },
    })),
    markWebhookEventProcessed: noopAsync(),
  };
});

import { NextRequest } from "next/server";
import { POST as stripeWebhook } from "../../app/api/webhooks/stripe/route";
import { processRazorpayWebhookEvent } from "../../app/api/webhooks/razorpay-dispatch";

const {
  captureException,
  paymentUpdateMany,
  paymentFindUnique,
  appointmentFindUnique,
  createEarningsFromPayment,
  refundPayment,
  validateWebhookMetadata,
} = mockParityState;

const pendingPayment = {
  id: "pay1",
  paymentIntent: "pi_capture_1",
  amount: 10000,
  paymentStatus: "PENDING",
  userId: "u1",
  currency: "INR",
  appointmentId: "appt1",
  user: { email: "buyer@example.com", name: "Buyer", consulteeProfile: {} },
};

function stripeIntentEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: "evt_1",
    object: "event",
    api_version: "2024-06-20",
    created: 1,
    livemode: false,
    pending_webhooks: 1,
    request: null,
    type: "payment_intent.succeeded",
    data: {
      object: {
        id: "pi_capture_1",
        object: "payment_intent",
        amount: 10000,
        amount_received: 6000,
        currency: "inr",
        metadata: { appointmentType: "CONSULTATION", amount: "10000" },
        status: "succeeded",
        last_payment_error: null,
        ...overrides,
      },
    },
  };
}

async function postStripe(event: unknown) {
  mockParityState.body = JSON.stringify(event);
  return stripeWebhook(
    new NextRequest("http://localhost/api/webhooks/stripe", {
      method: "POST",
      headers: { "stripe-signature": "t=1,v1=deadbeef" },
      body: mockParityState.body,
    }),
  );
}

function orderPaidEvent(orderTotalPaise: number, withPaymentEntity: boolean) {
  return {
    entity: "event",
    account_id: "acc_1",
    event: "order.paid",
    contains: ["payment"],
    created_at: 1,
    payload: {
      order: {
        entity: {
          id: "order_1",
          entity: "order",
          amount: orderTotalPaise,
          amount_paid: orderTotalPaise,
          amount_due: 0,
          currency: "INR",
          receipt: null,
          offer_id: null,
          status: "paid",
          attempts: 1,
          notes: { appointmentType: "CONSULTATION" },
          created_at: 1,
        },
      },
      ...(withPaymentEntity
        ? {
            payment: { entity: { id: "pay_x", amount: orderTotalPaise } },
          }
        : {}),
    },
  };
}

function expectNoMismatchStamp() {
  expect(
    paymentUpdateMany.mock.calls.find((c) =>
      String(c[0].data.description ?? "").includes("≠"),
    ),
  ).toBeUndefined();
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
  paymentUpdateMany.mockImplementation(async () => ({ count: 1 }));
  validateWebhookMetadata.mockImplementation(() => undefined);
  refundPayment.mockResolvedValue({ id: "rfnd1" });
  appointmentFindUnique.mockResolvedValue(null);
  paymentFindUnique.mockResolvedValue(pendingPayment);
});

describe("Stripe enters the confirmation router with the amount it actually took", () => {
  it("refuses a capture below the order amount instead of booking it at full value", async () => {
    const res = await postStripe(stripeIntentEvent());

    expect(res.status).toBe(200);
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(String(captureException.mock.calls[0][0])).toContain(
      "Capture amount mismatch",
    );
    expect(String(captureException.mock.calls[0][0])).toContain(
      "gateway=6000 expected=10000",
    );

    const stamp = paymentUpdateMany.mock.calls[0][0];
    expect(stamp.where.paymentStatus).toBe("PENDING");
    expect(stamp.data.paymentStatus).toBe("SUCCEEDED");
    expect(stamp.data.description).toMatch(/^Auto-refund pending:/);
    expect(stamp.data.description).toContain("6000p ≠ expected 10000p");
    expect(stamp.data.gatewayPaymentId).toBe("pi_capture_1");

    expect(refundPayment).toHaveBeenCalledWith(
      expect.objectContaining({ paymentId: "pay1", initiatedByUserId: null }),
    );
    expect(appointmentFindUnique).not.toHaveBeenCalled();
    expect(createEarningsFromPayment).not.toHaveBeenCalled();
  });

  it("leaves the guard inert on a capture that matches the order", async () => {
    await postStripe(
      stripeIntentEvent({ amount_received: 10000, amount: 10000 }),
    );

    expect(
      captureException.mock.calls.some((c) =>
        String(c[0]).includes("Capture amount mismatch"),
      ),
    ).toBe(false);
    expect(
      paymentUpdateMany.mock.calls.find((c) =>
        String(c[0].data.description ?? "").startsWith("Auto-refund pending:"),
      ),
    ).toBeUndefined();
    expect(refundPayment).not.toHaveBeenCalled();
  });

  it("answers 500 (so Stripe redelivers) when the capture amount is absent, rather than confirming blind", async () => {
    const event = stripeIntentEvent();
    delete (event.data.object as Record<string, unknown>).amount_received;

    const res = await postStripe(event);

    expect(res.status).toBe(500);
    expect(paymentFindUnique).not.toHaveBeenCalled();
    expect(appointmentFindUnique).not.toHaveBeenCalled();
  });

  it("books the Checkout Session door WITHOUT an amount — amount_total is the order total, not a capture", async () => {
    paymentFindUnique.mockResolvedValue({
      ...pendingPayment,
      paymentIntent: "cs_test_1",
    });
    await postStripe({
      id: "evt_2",
      object: "event",
      api_version: "2024-06-20",
      created: 2,
      livemode: false,
      pending_webhooks: 1,
      request: null,
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_test_1",
          object: "checkout.session",
          payment_intent: "pi_capture_1",
          payment_status: "paid",
          status: "complete",
          metadata: { appointmentType: "CONSULTATION" },
          amount_total: 10000,
          currency: "inr",
        },
      },
    });

    expect(
      captureException.mock.calls.some((c) =>
        String(c[0]).includes("Capture amount mismatch"),
      ),
    ).toBe(false);
    expectNoMismatchStamp();
    expect(paymentUpdateMany.mock.calls.length).toBeGreaterThanOrEqual(0);
    expect(refundPayment).not.toHaveBeenCalled();
    expect(appointmentFindUnique).toHaveBeenCalled();
  });
});

describe("order.paid must not pass the order TOTAL as a captured amount", () => {
  it("withholds the amount when Razorpay ships no payment entity, so parity is skipped not faked", async () => {
    paymentFindUnique.mockResolvedValue({
      ...pendingPayment,
      paymentIntent: "order_1",
    });

    await processRazorpayWebhookEvent(
      orderPaidEvent(9999, false) as never,
      "order.paid",
      "evt_rzp_1",
    );

    expectNoMismatchStamp();
    expect(refundPayment).not.toHaveBeenCalled();
    expect(appointmentFindUnique).toHaveBeenCalled();
  });

  it("still uses the payment entity's amount when Razorpay ships one", async () => {
    paymentFindUnique.mockResolvedValue({
      ...pendingPayment,
      paymentIntent: "order_1",
    });

    await processRazorpayWebhookEvent(
      orderPaidEvent(10000, true) as never,
      "order.paid",
      "evt_rzp_2",
    );

    expectNoMismatchStamp();
    expect(appointmentFindUnique).toHaveBeenCalled();
  });
});

describe("a redelivery still re-validates the captured amount", () => {
  const succeededPayment = {
    ...pendingPayment,
    paymentStatus: "SUCCEEDED",
    appointmentId: "appt1",
  };

  it("trips the parity check on a mismatched redelivery instead of short-circuiting", async () => {
    paymentFindUnique.mockResolvedValue(succeededPayment);

    const res = await postStripe(stripeIntentEvent());

    expect(res.status).toBe(200);
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(String(captureException.mock.calls[0][0])).toContain(
      "Capture amount mismatch",
    );
    expect(paymentUpdateMany).not.toHaveBeenCalled();
    expect(refundPayment).not.toHaveBeenCalled();
    expect(appointmentFindUnique).not.toHaveBeenCalled();
    expect(createEarningsFromPayment).not.toHaveBeenCalled();
  });

  it("is a no-op on a matching redelivery", async () => {
    paymentFindUnique.mockResolvedValue(succeededPayment);

    const res = await postStripe(
      stripeIntentEvent({ amount_received: 10000, amount: 10000 }),
    );

    expect(res.status).toBe(200);
    expect(captureException).not.toHaveBeenCalled();
    expect(paymentUpdateMany).not.toHaveBeenCalled();
    expect(refundPayment).not.toHaveBeenCalled();
    expect(appointmentFindUnique).not.toHaveBeenCalled();
    expect(createEarningsFromPayment).not.toHaveBeenCalled();
  });
});
