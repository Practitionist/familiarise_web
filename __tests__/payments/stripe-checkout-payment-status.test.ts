/**
 * @jest-environment node
 */

/**
 * `checkout.session.completed` is NOT a money event.
 *
 * Stripe fires it when the CHECKOUT is complete, which is a different moment
 * from the payment being collected: `payment_status` is `unpaid` while an
 * async/delayed method is in flight, and on the window between a card's
 * authorisation and a 3DS step the buyer has not finished. This door routes
 * every completed session into `routeCapturedPayment` without reading that
 * field, so a `unpaid` session confirmed a consultant's time with nothing
 * received — a real under-collection behind a live commitment, and the more
 * dangerous of the two options because a PENDING hold and a SUCCEEDED booking
 * look identical to a reader.
 *
 * The door deliberately withholds the captured amount (see the comment in the
 * route: `amount_total` is the ORDER total and must not feed the parity check),
 * so `payment_status` is the only gateway-truth signal left on this payload.
 * It answers exactly the question the door has to ask: did money arrive?
 *
 * `routeCapturedPayment` is wrapped rather than stubbed — it records its
 * arguments AND calls through to the real implementation, so these tests pin
 * both what the door hands the router (the withheld-amount behaviour) and what
 * the router then does to the Payment row (the confirmation). Only the
 * transport edges (signature, dedupe log, DB health) and the prisma/notification
 * graph are mocked, matching capture-amount-parity-plumbing.test.ts.
 */

const mockCheckoutHarness = {
  rawPayload: "{}",
  routerInvocations: [] as Array<Record<string, unknown>>,
  sentryCaptureException: jest.fn((..._args: unknown[]): unknown => undefined),
  sentryCaptureMessage: jest.fn((..._args: unknown[]): unknown => undefined),
  casPaymentStamp: jest.fn(
    async (_payload: {
      where: { paymentStatus?: string };
      data: {
        paymentStatus?: string;
        description?: string;
        gatewayPaymentId?: string | null;
      };
    }) => ({ count: 1 }),
  ),
  lookupPaymentByIntent: jest.fn(
    (..._args: unknown[]): Promise<unknown> => Promise.resolve(undefined),
  ),
  lookupAppointmentById: jest.fn(
    (..._args: unknown[]): Promise<unknown> => Promise.resolve(undefined),
  ),
  updatePaymentInTx: jest.fn(async (..._args: unknown[]) => ({})),
  updateTrialsInTx: jest.fn(async (..._args: unknown[]) => ({ count: 1 })),
  findTrialInTx: jest.fn((..._args: unknown[]): unknown => undefined),
  findOccurrencesInTx: jest.fn(),
  updatePaymentOutsideTx: jest.fn(async (..._args: unknown[]) => ({})),
  preplanEarnings: jest.fn(
    (..._args: unknown[]): Promise<unknown> => Promise.resolve(null),
  ),
  bookEarnings: jest.fn(),
  triggerRefund: jest.fn(
    (..._args: unknown[]): Promise<unknown> => Promise.resolve(undefined),
  ),
  emitSystemEvent: jest.fn(async (..._args: unknown[]) => undefined),
  checkWebhookMetadata: jest.fn((..._args: unknown[]): unknown => undefined),
  markProcessed: jest.fn(async (..._args: unknown[]) => undefined),
};

const mockSessionTx = {
  payment: {
    findUnique: mockCheckoutHarness.lookupPaymentByIntent,
    updateMany: mockCheckoutHarness.casPaymentStamp,
    update: mockCheckoutHarness.updatePaymentInTx,
  },
  appointment: { findUnique: mockCheckoutHarness.lookupAppointmentById },
  trial: {
    updateMany: mockCheckoutHarness.updateTrialsInTx,
    findUnique: mockCheckoutHarness.findTrialInTx,
  },
  appointmentOccurrence: { findMany: mockCheckoutHarness.findOccurrencesInTx },
};

jest.mock("@sentry/nextjs", () => {
  const nop = jest.fn();
  return {
    __esModule: true,
    setTag: nop,
    captureException: (...args: unknown[]) =>
      mockCheckoutHarness.sentryCaptureException(...args),
    captureMessage: (...args: unknown[]) =>
      mockCheckoutHarness.sentryCaptureMessage(...args),
    logger: {
      info: nop,
      warn: nop,
      error: nop,
      fmt: (parts: TemplateStringsArray) => parts.join(""),
    },
    getCurrentScope: () => ({ setTag: nop }),
  };
});

jest.mock("../../lib/db/serializable-retry", () => ({
  __esModule: true,
  withSerializableRetry: (op: () => unknown) => Promise.resolve(op()),
}));

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    $transaction: (cb: (db: unknown) => unknown) =>
      Promise.resolve(cb(mockSessionTx)),
    payment: {
      update: (...args: unknown[]) =>
        mockCheckoutHarness.updatePaymentOutsideTx(...(args as [never])),
    },
    webhookEvent: {
      updateMany: jest.fn(() => Promise.resolve({ count: 1 })),
    },
  },
}));

jest.mock("../../lib/payments/payouts", () => ({
  planEarningsForPayment: (...args: unknown[]) =>
    mockCheckoutHarness.preplanEarnings(...args),
  createEarningsFromPayment: (...args: unknown[]) =>
    mockCheckoutHarness.bookEarnings(...args),
}));
jest.mock("../../lib/payments/operations/refund", () => ({
  refundPayment: (...args: unknown[]) =>
    mockCheckoutHarness.triggerRefund(...args),
}));
jest.mock("../../lib/payments/operations/booking-refund", () => ({
  refundBookingPayment: jest.fn(),
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
jest.mock("../../lib/enterprise/system-events", () => {
  const forward = (...args: unknown[]) =>
    mockCheckoutHarness.emitSystemEvent(...(args as [never]));
  return {
    recordSystemError: forward,
    recordSystemErrorSafe: forward,
    recordSystemEventSafe: forward,
  };
});
jest.mock("../../schemas/webhooks/metadata", () => ({
  normalizeLegacySlotKeys: <T>(meta: T) => meta,
  validateWebhookMetadata: (...args: unknown[]) =>
    mockCheckoutHarness.checkWebhookMetadata(...args),
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

jest.mock("../../app/api/webhooks/razorpay-dispatch", () => {
  const actualDispatch = jest.requireActual(
    "../../app/api/webhooks/razorpay-dispatch",
  );
  return {
    __esModule: true,
    routeCapturedPayment: async (params: Record<string, unknown>) => {
      mockCheckoutHarness.routerInvocations.push({ ...params });
      return (
        actualDispatch.routeCapturedPayment as (
          p: Record<string, unknown>,
        ) => Promise<void>
      )(params);
    },
    processRazorpayWebhookEvent: actualDispatch.processRazorpayWebhookEvent,
  };
});

jest.mock("../../app/api/webhooks/utils", () => {
  const actualHandlers = jest.requireActual(
    "../../lib/payments/webhooks/handlers",
  );
  const asyncStub = () => jest.fn(() => Promise.resolve(undefined));
  return {
    __esModule: true,
    handlePaymentSuccess: actualHandlers.handlePaymentSuccess,
    handlePaymentFailure: asyncStub(),
    handleOrgPaymentSuccess: asyncStub(),
    handleOrgPaymentFailure: asyncStub(),
    handleRefundCreated: asyncStub(),
    handleDisputeCreated: asyncStub(),
    handleDisputeUpdated: asyncStub(),
    handleRazorpayPayoutWebhook: asyncStub(),
    handleStripePayoutWebhook: asyncStub(),
    DeferSignal: class DeferSignal {},
    isDbHealthy: jest.fn(() => Promise.resolve(true)),
    verifyWebhookSignature: jest.fn(() =>
      Promise.resolve({
        isValid: true,
        body: mockCheckoutHarness.rawPayload,
        oversized: false,
      }),
    ),
    logWebhookEvent: jest.fn(() =>
      Promise.resolve({
        isNew: true,
        claim: { id: "we1" },
      }),
    ),
    markWebhookEventProcessed: (...args: unknown[]) =>
      mockCheckoutHarness.markProcessed(...args),
  };
});

import { NextRequest } from "next/server";
import { POST as stripeWebhook } from "../../app/api/webhooks/stripe/route";

const {
  routerInvocations: mockRouterCalls,
  sentryCaptureException: captureException,
  casPaymentStamp: paymentUpdateMany,
  lookupPaymentByIntent: paymentFindUnique,
  lookupAppointmentById: appointmentFindUnique,
  findOccurrencesInTx: occurrenceFindMany,
  preplanEarnings: planEarningsForPayment,
  bookEarnings: createEarningsFromPayment,
  triggerRefund: refundPayment,
  checkWebhookMetadata: validateWebhookMetadata,
  markProcessed: mockMarkWebhookEventProcessed,
} = mockCheckoutHarness;

const pendingSessionPayment = {
  id: "pay1",
  paymentIntent: "cs_test_1",
  amount: 10000,
  paymentStatus: "PENDING",
  userId: "u1",
  currency: "INR",
  appointmentId: "appt1",
  user: { email: "buyer@example.com", name: "Buyer", consulteeProfile: {} },
};

function sessionCompletedEvent(sessionOverrides: Record<string, unknown> = {}) {
  return {
    id: "evt_cs_1",
    object: "event",
    api_version: "2024-06-20",
    created: 1,
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
        ...sessionOverrides,
      },
    },
  };
}

async function sendStripeSessionWebhook(payload: unknown) {
  mockCheckoutHarness.rawPayload = JSON.stringify(payload);
  return stripeWebhook(
    new NextRequest("http://localhost/api/webhooks/stripe", {
      method: "POST",
      headers: { "stripe-signature": "t=1,v1=deadbeef" },
      body: mockCheckoutHarness.rawPayload,
    }),
  );
}

function expectSessionNotRouted() {
  expect(mockRouterCalls).toHaveLength(0);
  expect(paymentFindUnique).not.toHaveBeenCalled();
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
  mockRouterCalls.length = 0;
  paymentUpdateMany.mockImplementation(async () => ({ count: 1 }));
  validateWebhookMetadata.mockImplementation(() => undefined);
  refundPayment.mockResolvedValue({ id: "rfnd1" });
  appointmentFindUnique.mockResolvedValue(null);
  paymentFindUnique.mockResolvedValue(pendingSessionPayment);
});

describe("a session with no collected money must not confirm a booking", () => {
  it("does not route an `unpaid` session into the confirmation router at all", async () => {
    const res = await sendStripeSessionWebhook(
      sessionCompletedEvent({ payment_status: "unpaid" }),
    );

    expect(res.status).toBe(200);
    expectSessionNotRouted();
    expect(appointmentFindUnique).not.toHaveBeenCalled();
    expect(createEarningsFromPayment).not.toHaveBeenCalled();
    expect(paymentUpdateMany).not.toHaveBeenCalled();
  });

  it("names the invariant in a warn so the park is visible, not a silent drop", async () => {
    const warn = jest
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    let line = "";
    try {
      await sendStripeSessionWebhook(
        sessionCompletedEvent({ payment_status: "unpaid" }),
      );
      line = warn.mock.calls.map((c) => String(c[0])).join("\n");
    } finally {
      warn.mockRestore();
    }
    expect(line).toContain("cs_test_1");
    expect(line).toContain('payment_status="unpaid"');
    expect(line).toContain("NOT confirming a booking");
    expect(line).toContain("reconcile-payment-status");
  });

  it("refuses `no_payment_required` too, rather than treating it as free money", async () => {
    const res = await sendStripeSessionWebhook(
      sessionCompletedEvent({
        payment_status: "no_payment_required",
        amount_total: 0,
      }),
    );

    expect(res.status).toBe(200);
    expectSessionNotRouted();
  });

  it("fails closed on an unrecognised future payment_status value", async () => {
    const res = await sendStripeSessionWebhook(
      sessionCompletedEvent({ payment_status: "partially_refunded" }),
    );

    expect(res.status).toBe(200);
    expectSessionNotRouted();
  });
});

describe("a paid session still confirms, and still withholds the amount", () => {
  it("routes a `paid` session and passes NO amountPaise", async () => {
    await sendStripeSessionWebhook(
      sessionCompletedEvent({ payment_status: "paid" }),
    );

    expect(mockRouterCalls).toHaveLength(1);
    const call = mockRouterCalls[0];
    expect(call.orderId).toBe("cs_test_1");
    expect(call.gatewayPaymentId).toBe("pi_capture_1");
    expect(call.notes).toEqual({ appointmentType: "CONSULTATION" });

    expect("amountPaise" in call).toBe(false);
    expect(Object.keys(call).sort()).toEqual([
      "gatewayPaymentId",
      "notes",
      "orderId",
    ]);

    expect(
      captureException.mock.calls.some((c) =>
        String(c[0]).includes("Capture amount mismatch"),
      ),
    ).toBe(false);
    expect(
      paymentUpdateMany.mock.calls.find((c) =>
        String(c[0].data.description ?? "").includes("≠"),
      ),
    ).toBeUndefined();
    expect(refundPayment).not.toHaveBeenCalled();
    expect(appointmentFindUnique).toHaveBeenCalled();
  });
});

describe("a missing payment_status is refused by the schema, not assumed paid", () => {
  it("refuses without routing and records a permanent schema failure on the webhook event row", async () => {
    const event = sessionCompletedEvent();
    delete (event.data.object as Record<string, unknown>).payment_status;

    const res = await sendStripeSessionWebhook(event);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: "ignored",
      reason: "invalid_payload",
    });
    expectSessionNotRouted();
    expect(appointmentFindUnique).not.toHaveBeenCalled();
    expect(paymentUpdateMany).not.toHaveBeenCalled();

    expect(mockMarkWebhookEventProcessed).toHaveBeenCalled();
    const [, processingError] = mockMarkWebhookEventProcessed.mock.calls[0];
    expect(typeof processingError).toBe("string");
    expect(String(processingError)).toContain("payment_status");
  });
});

describe("Phase-1 atomic earnings creation (#1758) & Razorpay nested envelope fixtures (#1737)", () => {
  it("creates consultant earnings inside Phase 1 when confirming a tentative appointment (#1758)", async () => {
    appointmentFindUnique.mockResolvedValue({
      id: "appt1",
      slotsOfAppointment: [
        {
          id: "slot1",
          isTentative: true,
          startsAt: new Date("2026-06-01T10:00:00Z"),
        },
      ],
    });
    occurrenceFindMany.mockResolvedValue([]);
    (mockSessionTx.appointmentOccurrence as Record<string, unknown>).updateMany =
      jest.fn(async () => ({ count: 1 }));
    (mockSessionTx as Record<string, unknown>).appointmentParticipant = {
      updateMany: jest.fn(async () => ({ count: 1 })),
    };
    planEarningsForPayment.mockResolvedValueOnce({
      resolvedPayment: {
        paymentForEarnings: pendingSessionPayment,
        earningsAppointmentType: "CONSULTATION",
        consultantProfileId: "cp1",
      },
    });

    try {
      await sendStripeSessionWebhook(
        sessionCompletedEvent({ payment_status: "paid" }),
      );

      expect(createEarningsFromPayment).toHaveBeenCalledTimes(1);
      expect(createEarningsFromPayment).toHaveBeenCalledWith(
        expect.objectContaining({
          payment: pendingSessionPayment,
          appointmentType: "CONSULTATION",
          tx: mockSessionTx,
        }),
      );
    } finally {
      delete (mockSessionTx.appointmentOccurrence as Record<string, unknown>)
        .updateMany;
      delete (mockSessionTx as Record<string, unknown>).appointmentParticipant;
    }
  });

  it("buildRazorpayPaymentCapturedEnvelope and buildRazorpayRefundCreatedEnvelope satisfy razorpay webhook schemas (#1737)", () => {
    const {
      buildRazorpayPaymentCapturedEnvelope,
      buildRazorpayRefundCreatedEnvelope,
    } = jest.requireActual(
      "../../tests/typescript/race-conditions/utilities/fixtures",
    );
    const {
      razorpayPaymentCapturedEventSchema,
      razorpayWebhookEnvelopeSchema,
    } = jest.requireActual("../../schemas/webhooks/razorpay");

    const captured = JSON.parse(
      buildRazorpayPaymentCapturedEnvelope({
        orderId: "order_test_1737",
        paymentId: "pay_test_1737",
        amount: 50000,
        notes: { appointmentId: "appt_1737" },
      }),
    );
    const parsedCaptured =
      razorpayPaymentCapturedEventSchema.safeParse(captured);
    expect(parsedCaptured.success).toBe(true);

    const refunded = JSON.parse(
      buildRazorpayRefundCreatedEnvelope({
        refundId: "rfnd_test_1737",
        paymentId: "pay_test_1737",
        amount: 25000,
        status: "processed",
      }),
    );
    const parsedRefunded = razorpayWebhookEnvelopeSchema.safeParse(refunded);
    expect(parsedRefunded.success).toBe(true);
    expect(parsedRefunded.data?.payload?.refund?.entity?.id).toBe(
      "rfnd_test_1737",
    );
  });
});

