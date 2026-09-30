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

const captureException = jest.fn();
const captureMessage = jest.fn();
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
  async (_args: { where: { paymentStatus?: string } }) => ({ count: 1 }),
);
const paymentFindUnique = jest.fn();
const appointmentFindUnique = jest.fn();
const txPaymentUpdate = jest.fn(async () => ({}));
const trialUpdateMany = jest.fn(async () => ({ count: 1 }));
const trialFindUnique = jest.fn();
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
// The Phase-2 settle-marker write runs on the base client, outside the tx.
const prismaPaymentUpdate = jest.fn(async () => ({}));
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    $transaction: async (fn: (tx: unknown) => unknown) => fn(txStub),
    payment: {
      update: (...a: unknown[]) => prismaPaymentUpdate(...(a as [never])),
    },
    webhookEvent: { updateMany: jest.fn(async () => ({ count: 1 })) },
  },
}));

// Side-effectful import graph — present so the modules load. The mismatch and
// redelivery paths return before any of it runs.
const createEarningsFromPayment = jest.fn();
jest.mock("../../lib/payments/payouts", () => ({
  createEarningsFromPayment: (...a: unknown[]) =>
    createEarningsFromPayment(...a),
}));
const refundPayment = jest.fn();
jest.mock("../../lib/payments/operations/refund", () => ({
  refundPayment: (...a: unknown[]) => refundPayment(...a),
}));
const refundBookingPayment = jest.fn();
jest.mock("../../lib/payments/operations/booking-refund", () => ({
  refundBookingPayment: (...a: unknown[]) => refundBookingPayment(...a),
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
const recordSystemEvent = jest.fn(async () => undefined);
jest.mock("../../lib/enterprise/system-events", () => ({
  recordSystemError: (...a: unknown[]) => recordSystemEvent(...(a as [never])),
  recordSystemErrorSafe: (...a: unknown[]) =>
    recordSystemEvent(...(a as [never])),
  recordSystemEventSafe: (...a: unknown[]) =>
    recordSystemEvent(...(a as [never])),
}));
const validateWebhookMetadata = jest.fn();
jest.mock("../../schemas/webhooks/metadata", () => ({
  normalizeLegacySlotKeys: (m: unknown) => m,
  validateWebhookMetadata: (...a: unknown[]) => validateWebhookMetadata(...a),
}));

// razorpay-dispatch imports the razorpay client at module scope; the only
// family that constructs one is `refund.*`, which these tests never reach.
jest.mock("../../lib/payments/core/razorpay", () => ({}));
jest.mock("../../lib/payments/webhooks/overage-handlers", () => ({
  handleOverageMemberSuccess: jest.fn(),
  handleOverageMemberFailure: jest.fn(),
}));
jest.mock("../../lib/payments/webhooks/recording-purchase", () => ({
  handleRecordingPurchaseSuccess: jest.fn(),
  handleRecordingPurchaseFailure: jest.fn(),
}));

// The webhook transport edges. handlePaymentSuccess is deliberately the REAL
// one: stubbing it would let a door pass a wrong amount and still look fine.
// `mock` prefix is required — jest.mock factories may only close over
// variables whose names begin with it.
let mockWebhookBody = "{}";
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
    markWebhookEventProcessed: jest.fn(async () => undefined),
  };
});

import { NextRequest } from "next/server";
import { POST as stripeWebhook } from "../../app/api/webhooks/stripe/route";
import { processRazorpayWebhookEvent } from "../../app/api/webhooks/razorpay-dispatch";

/** The Payment row every capture resolves to: 10000p. */
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
        // The AUTHORISED figure, and the figure metadata echoes. Deliberately
        // 10000 — the order total — so a door that read either of them would
        // look identical to a correct one and pass this suite.
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
  mockWebhookBody = JSON.stringify(event);
  return stripeWebhook(
    new NextRequest("http://localhost/api/webhooks/stripe", {
      method: "POST",
      headers: { "stripe-signature": "t=1,v1=deadbeef" },
      body: mockWebhookBody,
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

beforeEach(() => {
  jest.clearAllMocks();
  paymentUpdateMany.mockImplementation(async () => ({ count: 1 }));
  validateWebhookMetadata.mockImplementation(() => undefined);
  refundPayment.mockResolvedValue({ id: "rfnd1" });
  appointmentFindUnique.mockResolvedValue(null);
  paymentFindUnique.mockResolvedValue(pendingPayment);
});

describe("Stripe enters the confirmation router with the amount it actually took", () => {
  it("refuses a capture below the order amount instead of booking it at full value", async () => {
    // `amount_received` is 6000; Payment.amount is 10000. Booking this at 10000
    // is the silent under-collection this pins shut.
    const res = await postStripe(stripeIntentEvent());

    expect(res.status).toBe(200);
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(String(captureException.mock.calls[0][0])).toContain(
      "Capture amount mismatch",
    );
    expect(String(captureException.mock.calls[0][0])).toContain(
      "gateway=6000 expected=10000",
    );

    // The auto-refund marker is stamped under the PENDING predicate, then the
    // capture is auto-refunded through the front door.
    const stamp = paymentUpdateMany.mock.calls[0][0];
    expect(stamp.where.paymentStatus).toBe("PENDING");
    expect(stamp.data.paymentStatus).toBe("SUCCEEDED");
    expect(stamp.data.description).toMatch(/^Auto-refund pending:/);
    expect(stamp.data.description).toContain("6000p ≠ expected 10000p");
    // #1353 — the refund webhook that comes back carries only the `pay_…`
    // analogue, so this branch is the one that most needs the id persisted.
    expect(stamp.data.gatewayPaymentId).toBe("pi_capture_1");

    expect(refundPayment).toHaveBeenCalledWith(
      expect.objectContaining({ paymentId: "pay1", initiatedByUserId: null }),
    );

    // Nothing was confirmed and no earnings were booked.
    expect(appointmentFindUnique).not.toHaveBeenCalled();
    expect(createEarningsFromPayment).not.toHaveBeenCalled();
  });

  it("leaves the guard inert on a capture that matches the order", async () => {
    // The counterpart to the refusal above: with `amount_received` == 10000 the
    // guard must not fire, which is only true if the door read
    // `amount_received` (6000 in the test above would have fired) rather than
    // `intent.amount`, the metadata order total, or nothing at all.
    await postStripe(
      stripeIntentEvent({ amount_received: 10000, amount: 10000 }),
    );

    expect(captureException).not.toHaveBeenCalled();
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

  it("books the Checkout Session door off the session total and the pi_ id", async () => {
    paymentFindUnique.mockResolvedValue({
      ...pendingPayment,
      paymentIntent: "cs_test_1",
    });
    const res = await postStripe({
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

    expect(res.status).toBe(200);
    // The session's own `amount_total` is what the guard saw, and it equals
    // Payment.amount — so no remediation ran and the flow proceeded past it.
    expect(
      paymentUpdateMany.mock.calls.find((c) =>
        String(c[0].data.description ?? "").includes("≠"),
      ),
    ).toBeUndefined();
    expect(refundPayment).not.toHaveBeenCalled();
    expect(appointmentFindUnique).toHaveBeenCalled();
  });
});

describe("order.paid must not pass the order TOTAL as a captured amount", () => {
  it("withholds the amount when Razorpay ships no payment entity, so parity is skipped not faked", async () => {
    // The order total (9999) deliberately differs from Payment.amount (10000).
    // The old `?? order.entity.amount` fallback fed 9999 in as "the captured
    // amount" and the guard compared the gateway against itself, so this case
    // tripped a FALSE mismatch — the mirror image of the bug, and equally wrong.
    paymentFindUnique.mockResolvedValue({
      ...pendingPayment,
      paymentIntent: "order_1",
    });

    await processRazorpayWebhookEvent(
      orderPaidEvent(9999, false) as never,
      "order.paid",
      "evt_rzp_1",
    );

    // No mismatch remediation ran: no auto-refund marker, no auto-refund call.
    expect(
      paymentUpdateMany.mock.calls.find((c) =>
        String(c[0].data.description ?? "").includes("≠"),
      ),
    ).toBeUndefined();
    expect(refundPayment).not.toHaveBeenCalled();
    // …and the flow got PAST the guard to the tentative appointment lookup, so
    // parity was SKIPPED for want of a figure — the pre-#1582 posture — rather
    // than decided on the order total.
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

    // 10000 == Payment.amount, so the guard is inert and the flow proceeded.
    expect(
      paymentUpdateMany.mock.calls.find((c) =>
        String(c[0].data.description ?? "").includes("≠"),
      ),
    ).toBeUndefined();
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
    // The short-circuit used to fire here and return null before the
    // comparison, so a replay of a wrong-amount capture looked like agreement.
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(String(captureException.mock.calls[0][0])).toContain(
      "Capture amount mismatch",
    );
    // …and the first delivery already stamped and refunded, so the redelivery
    // must not stamp again or issue a second refund.
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
    // Reaching the short-circuit at all is the point: the amount was compared
    // first and AGREED, so "nothing to do" is a real verdict, not a skip.
    expect(captureException).not.toHaveBeenCalled();
    expect(paymentUpdateMany).not.toHaveBeenCalled();
    expect(refundPayment).not.toHaveBeenCalled();
    expect(appointmentFindUnique).not.toHaveBeenCalled();
    expect(createEarningsFromPayment).not.toHaveBeenCalled();
  });
});
