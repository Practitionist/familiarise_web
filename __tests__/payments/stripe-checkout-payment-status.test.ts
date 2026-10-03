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

const captureException = jest.fn((..._a: unknown[]): unknown => undefined);
const captureMessage = jest.fn((..._a: unknown[]): unknown => undefined);
jest.mock("@sentry/nextjs", () => ({
  __esModule: true,
  setTag: jest.fn(),
  captureException: (...a: unknown[]) => captureException(...a),
  captureMessage: (...a: unknown[]) => captureMessage(...a),
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    fmt: (strings: TemplateStringsArray) => strings.join(""),
  },
  getCurrentScope: () => ({ setTag: jest.fn() }),
}));

jest.mock("../../lib/db/serializable-retry", () => ({
  __esModule: true,
  withSerializableRetry: async (fn: () => unknown) => fn(),
}));

// #1439 — every in-tx status stamp is a CAS, so the writer is `updateMany`
// and its count decides whether the flow continues.
const paymentUpdateMany = jest.fn(
  async (_args: {
    where: { paymentStatus?: string };
    data: {
      paymentStatus?: string;
      description?: string;
      gatewayPaymentId?: string | null;
    };
  }) => ({ count: 1 }),
);
const paymentFindUnique = jest.fn(
  (..._a: unknown[]): Promise<unknown> => Promise.resolve(undefined),
);
const appointmentFindUnique = jest.fn(
  (..._a: unknown[]): Promise<unknown> => Promise.resolve(undefined),
);
const txPaymentUpdate = jest.fn(async (..._a: unknown[]) => ({}));
const trialUpdateMany = jest.fn(async (..._a: unknown[]) => ({ count: 1 }));
const trialFindUnique = jest.fn((..._a: unknown[]): unknown => undefined);
const occurrenceFindMany = jest.fn();
const txStub = {
  payment: {
    findUnique: paymentFindUnique,
    updateMany: paymentUpdateMany,
    update: txPaymentUpdate,
  },
  appointment: { findUnique: appointmentFindUnique },
  trial: { updateMany: trialUpdateMany, findUnique: trialFindUnique },
  appointmentOccurrence: { findMany: occurrenceFindMany },
};
const prismaPaymentUpdate = jest.fn(async (..._a: unknown[]) => ({}));
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    $transaction: async (fn: (tx: unknown) => unknown) => fn(txStub),
    payment: {
      update: (...a: unknown[]) => prismaPaymentUpdate(...(a as [never])),
    },
    webhookEvent: {
      updateMany: jest.fn(async (..._a: unknown[]) => ({ count: 1 })),
    },
  },
}));

const planEarningsForPayment = jest.fn(
  (..._a: unknown[]): Promise<unknown> => Promise.resolve(null),
);
const createEarningsFromPayment = jest.fn();
jest.mock("../../lib/payments/payouts", () => ({
  planEarningsForPayment: (...a: unknown[]) => planEarningsForPayment(...a),
  createEarningsFromPayment: (...a: unknown[]) =>
    createEarningsFromPayment(...a),
}));
const refundPayment = jest.fn(
  (..._a: unknown[]): Promise<unknown> => Promise.resolve(undefined),
);
jest.mock("../../lib/payments/operations/refund", () => ({
  refundPayment: (...a: unknown[]) => refundPayment(...a),
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
const recordSystemEvent = jest.fn(async (..._a: unknown[]) => undefined);
jest.mock("../../lib/enterprise/system-events", () => ({
  recordSystemError: (...a: unknown[]) => recordSystemEvent(...(a as [never])),
  recordSystemErrorSafe: (...a: unknown[]) =>
    recordSystemEvent(...(a as [never])),
  recordSystemEventSafe: (...a: unknown[]) =>
    recordSystemEvent(...(a as [never])),
}));
const validateWebhookMetadata = jest.fn(
  (..._a: unknown[]): unknown => undefined,
);
jest.mock("../../schemas/webhooks/metadata", () => ({
  normalizeLegacySlotKeys: (m: unknown) => m,
  validateWebhookMetadata: (...a: unknown[]) => validateWebhookMetadata(...a),
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

/**
 * Record the door's arguments to the router, then call through to the real one.
 * Spreading is deliberate: the withheld-amount assertion asks whether the
 * `amountPaise` KEY is present at all, which a call-through wrapper can only see
 * if it copies the caller's own object rather than a normalised one.
 */
const mockRouterCalls: Array<Record<string, unknown>> = [];
jest.mock("../../app/api/webhooks/razorpay-dispatch", () => {
  const real = jest.requireActual("../../app/api/webhooks/razorpay-dispatch");
  return {
    __esModule: true,
    routeCapturedPayment: async (params: Record<string, unknown>) => {
      mockRouterCalls.push({ ...params });
      return (
        real.routeCapturedPayment as unknown as (
          p: Record<string, unknown>,
        ) => Promise<void>
      )(params);
    },
    processRazorpayWebhookEvent: real.processRazorpayWebhookEvent,
  };
});

// The webhook transport edges. handlePaymentSuccess is deliberately the REAL
// one: stubbing it would let a door confirm without the router and still look
// fine. `mock` prefix is required — jest.mock factories may only close over
// variables whose names begin with `mock`.
let mockWebhookBody = "{}";
// Typed with its real arity: the route calls it `(eventId, processingError,
// claim)`, and a zero-arg `jest.fn` types `mock.calls[0]` as `[]`, which makes
// reading `processingError` off it a compile error.
const mockMarkWebhookEventProcessed = jest.fn(
  async (..._a: unknown[]) => undefined,
);
jest.mock("../../app/api/webhooks/utils", () => {
  const real = jest.requireActual("../../lib/payments/webhooks/handlers");
  return {
    __esModule: true,
    handlePaymentSuccess: real.handlePaymentSuccess,
    handlePaymentFailure: jest.fn(async () => undefined),
    handleOrgPaymentSuccess: jest.fn(async () => undefined),
    handleOrgPaymentFailure: jest.fn(async () => undefined),
    handleRefundCreated: jest.fn(async () => undefined),
    handleDisputeCreated: jest.fn(async () => undefined),
    handleDisputeUpdated: jest.fn(async () => undefined),
    handleRazorpayPayoutWebhook: jest.fn(async () => undefined),
    handleStripePayoutWebhook: jest.fn(async () => undefined),
    DeferSignal: class DeferSignal {},
    isDbHealthy: jest.fn(async () => true),
    verifyWebhookSignature: jest.fn(async () => ({
      isValid: true,
      body: mockWebhookBody,
      oversized: false,
    })),
    logWebhookEvent: jest.fn(async () => ({
      isNew: true,
      claim: { id: "we1" },
    })),
    markWebhookEventProcessed: (...a: unknown[]) =>
      mockMarkWebhookEventProcessed(...a),
  };
});

import { NextRequest } from "next/server";
import { POST as stripeWebhook } from "../../app/api/webhooks/stripe/route";

/** The Payment row a paid session resolves to: 10000p, held not yet confirmed. */
const pendingPayment = {
  id: "pay1",
  // createStripeCheckoutSession returns session.id, so THIS is the cs_… —
  // which is exactly why the payment_intent.succeeded door (pi_…) cannot
  // resolve this row.
  paymentIntent: "cs_test_1",
  amount: 10000,
  paymentStatus: "PENDING",
  userId: "u1",
  currency: "INR",
  appointmentId: "appt1",
  user: { email: "buyer@example.com", name: "Buyer", consulteeProfile: {} },
};

function sessionCompletedEvent(session: Record<string, unknown> = {}) {
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
        ...session,
      },
    },
  };
}

async function postStripe(event: unknown) {
  mockWebhookBody = JSON.stringify(event);
  return stripeWebhook(
    new NextRequest("http://localhost/api/webhooks/stripe", {
      method: "POST",
      headers: { "stripe-signature": "t=1,v1=deadbeef" },
      body: mockWebhookBody,
    }),
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
  mockRouterCalls.length = 0;
  paymentUpdateMany.mockImplementation(async () => ({ count: 1 }));
  validateWebhookMetadata.mockImplementation(() => undefined);
  refundPayment.mockResolvedValue({ id: "rfnd1" });
  appointmentFindUnique.mockResolvedValue(null);
  paymentFindUnique.mockResolvedValue(pendingPayment);
});

describe("a session with no collected money must not confirm a booking", () => {
  it("does not route an `unpaid` session into the confirmation router at all", async () => {
    // The 3DS/async case: checkout complete, payment not collected.
    const res = await postStripe(
      sessionCompletedEvent({ payment_status: "unpaid" }),
    );

    // 200, not 500: the event is durably recorded, Stripe will not re-fire a
    // completed session, and logWebhookEvent short-circuits a retry of the same
    // evt_… as a duplicate — so a 500 would burn the retry schedule on a payload
    // that can never succeed. Same shape as an unhandled event.
    expect(res.status).toBe(200);

    // The router is the seam the gap lived at, so assert it was never entered.
    expect(mockRouterCalls).toHaveLength(0);

    // …and through the real confirmation graph, nothing read, nothing stamped:
    // no booking, no earnings, no status write. A `paymentStatus` write here
    // would be the other half of the same bug.
    expect(paymentFindUnique).not.toHaveBeenCalled();
    expect(appointmentFindUnique).not.toHaveBeenCalled();
    expect(createEarningsFromPayment).not.toHaveBeenCalled();
    expect(paymentUpdateMany).not.toHaveBeenCalled();
  });

  it("names the invariant in a warn so the park is visible, not a silent drop", async () => {
    const warn = jest
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    // Read the calls BEFORE restoring: `mockRestore()` resets the recorded
    // calls along with the implementation, so restoring in a `finally` and
    // asserting after it saw an empty array.
    let line = "";
    try {
      await postStripe(sessionCompletedEvent({ payment_status: "unpaid" }));
      line = warn.mock.calls.map((c) => String(c[0])).join("\n");
    } finally {
      warn.mockRestore();
    }
    expect(line).toContain("cs_test_1");
    expect(line).toContain('payment_status="unpaid"');
    expect(line).toContain("NOT confirming a booking");
    // The log must point at the durable park, or the next reader assumes the
    // booking is simply lost.
    expect(line).toContain("reconcile-payment-status");
  });

  it("refuses `no_payment_required` too, rather than treating it as free money", async () => {
    // A zero-total session cannot be this rail's PENDING B2C row: a
    // zero-amount checkout is confirmed synchronously in
    // lib/payments/operations/checkout.ts and createStripeCheckoutSession
    // throws on amount <= 0. So there is nothing to confirm here, and allowing
    // the value would open the door to a zero-money booking.
    const res = await postStripe(
      sessionCompletedEvent({
        payment_status: "no_payment_required",
        amount_total: 0,
      }),
    );

    expect(res.status).toBe(200);
    expect(mockRouterCalls).toHaveLength(0);
    expect(paymentFindUnique).not.toHaveBeenCalled();
  });

  it("fails closed on an unrecognised future payment_status value", async () => {
    // The guard is an allow-list, not a deny-list of the two known-bad values:
    // a value this build has never seen must not confirm a booking.
    const res = await postStripe(
      sessionCompletedEvent({ payment_status: "partially_refunded" }),
    );

    expect(res.status).toBe(200);
    expect(mockRouterCalls).toHaveLength(0);
    expect(paymentFindUnique).not.toHaveBeenCalled();
  });
});

describe("a paid session still confirms, and still withholds the amount", () => {
  it("routes a `paid` session and passes NO amountPaise", async () => {
    // NOT asserting on the response status: this suite runs the real router into
    // a stub graph that stops in Phase 2 ("Failed to create or find
    // appointment"), and the route turns that into a 500 for a reason that has
    // nothing to do with this door. What matters is the flow MOVED — see
    // appointmentFindUnique below.
    await postStripe(sessionCompletedEvent({ payment_status: "paid" }));

    expect(mockRouterCalls).toHaveLength(1);
    const call = mockRouterCalls[0];
    expect(call.orderId).toBe("cs_test_1");
    // #1353 — the pi_… is this rail's `pay_…`, so a later refund or dispute
    // resolves against the right gateway object.
    expect(call.gatewayPaymentId).toBe("pi_capture_1");
    expect(call.notes).toEqual({ appointmentType: "CONSULTATION" });

    // The withheld-amount behaviour, pinned as ABSENCE OF THE KEY rather than
    // `toBeUndefined()`. `amount_total` is 10000 and Payment.amount is 10000,
    // so a door that passed it would produce an identical booking — the only
    // way to tell the two apart is whether the key exists at all.
    expect("amountPaise" in call).toBe(false);
    expect(Object.keys(call).sort()).toEqual([
      "gatewayPaymentId",
      "notes",
      "orderId",
    ]);

    // Consequence of withholding: the parity check is skipped by construction,
    // so no remediation ran and the flow proceeded past the guard into Phase 2
    // (which is what appointmentFindUnique being called proves). This suite's
    // stub graph does not complete Phase 2, so the route reports a 500 for an
    // unrelated reason — assert the flow MOVED, not the status.
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
    // `payment_status` is REQUIRED by
    // stripeCheckoutSessionCompletedEventSchema (schemas/webhooks/stripe.ts),
    // so a payload without it cannot parse. That is the whole deliberate
    // handling: the schema is the fail-closed default, and the route must not
    // add a permissive fallback on top of it — an absent signal about money is
    // not evidence of money.
    const event = sessionCompletedEvent();
    delete (event.data.object as Record<string, unknown>).payment_status;

    const res = await postStripe(event);

    // ZodError answers 200 `{ status: "ignored", reason: "invalid_payload" }`
    // (#1935) so Stripe does not burn its retry schedule on a structurally
    // invalid event payload, while recording the failure on the event row.
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: "ignored",
      reason: "invalid_payload",
    });
    expect(mockRouterCalls).toHaveLength(0);
    expect(paymentFindUnique).not.toHaveBeenCalled();
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
    (txStub.appointmentOccurrence as Record<string, unknown>).updateMany =
      jest.fn(async () => ({ count: 1 }));
    (txStub as Record<string, unknown>).appointmentParticipant = {
      updateMany: jest.fn(async () => ({ count: 1 })),
    };
    planEarningsForPayment.mockResolvedValueOnce({
      resolvedPayment: {
        paymentForEarnings: pendingPayment,
        earningsAppointmentType: "CONSULTATION",
        consultantProfileId: "cp1",
      },
    });

    try {
      await postStripe(sessionCompletedEvent({ payment_status: "paid" }));

      expect(createEarningsFromPayment).toHaveBeenCalledTimes(1);
      expect(createEarningsFromPayment).toHaveBeenCalledWith(
        expect.objectContaining({
          payment: pendingPayment,
          appointmentType: "CONSULTATION",
          tx: txStub,
        }),
      );
    } finally {
      delete (txStub.appointmentOccurrence as Record<string, unknown>)
        .updateMany;
      delete (txStub as Record<string, unknown>).appointmentParticipant;
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

