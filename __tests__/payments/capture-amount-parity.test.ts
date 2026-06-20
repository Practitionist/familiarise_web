/**
 * @jest-environment node
 */

/**
 * #677 — defence-in-depth capture-amount parity in handlePaymentSuccess.
 *
 * The gateway order is created at checkout for exactly Payment.amount and the
 * webhook is HMAC-verified, so a captured amount that differs is a gateway
 * anomaly or our-own bug. handlePaymentSuccess must NOT silently confirm the
 * booking — it marks the payment REQUIRES_MANUAL_RECOVERY, pages (Sentry), and
 * returns before confirming. (The matching-amount happy path is exercised
 * end-to-end by the live signed-webhook verification; here we pin the new guard,
 * whose mismatch branch returns early — before any Phase-2 work.)
 */

const captureException = jest.fn();
jest.mock("@sentry/nextjs", () => ({
  __esModule: true,
  captureException: (...a: unknown[]) => captureException(...a),
}));

const withSerializableRetry = jest.fn(async (fn: () => unknown) => fn());
jest.mock("../../lib/db/serializable-retry", () => ({
  __esModule: true,
  withSerializableRetry: (fn: () => unknown) => withSerializableRetry(fn),
}));

const paymentUpdate = jest.fn(async () => ({}));
const paymentFindUnique = jest.fn();
const appointmentFindUnique = jest.fn();
const txStub = {
  payment: { findUnique: paymentFindUnique, update: paymentUpdate },
  appointment: { findUnique: appointmentFindUnique },
};
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: { $transaction: async (fn: (tx: unknown) => unknown) => fn(txStub) },
}));

// Side-effectful import graph — present only so the module loads; the mismatch
// branch returns before any of it runs.
const createEarningsFromPayment = jest.fn();
jest.mock("../../lib/payments/payouts", () => ({
  createEarningsFromPayment: (...a: unknown[]) => createEarningsFromPayment(...a),
}));
jest.mock("../../lib/payments/operations/refund", () => ({ refundPayment: jest.fn() }));
jest.mock("../../lib/email", () => ({
  sendPaymentSuccessEmail: jest.fn(),
  sendPaymentFailedEmail: jest.fn(),
}));
jest.mock("../../lib/waitlist/slot-handler", () => ({ markWaitlistAsBooked: jest.fn() }));
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
jest.mock("../../lib/enterprise/system-events", () => ({ recordSystemError: jest.fn() }));
jest.mock("../../schemas/webhooks/metadata", () => ({
  normalizeLegacySlotKeys: (m: unknown) => m,
  validateWebhookMetadata: jest.fn(),
}));

import { handlePaymentSuccess } from "../../lib/payments/webhooks/handlers";

beforeEach(() => {
  jest.clearAllMocks();
  paymentFindUnique.mockResolvedValue({
    id: "pay1",
    paymentIntent: "order1",
    amount: 10000,
    paymentStatus: "PENDING",
    userId: "u1",
    currency: "INR",
    appointmentId: "appt1",
    user: { email: "buyer@example.com", name: "Buyer", consulteeProfile: {} },
  });
});

describe("#677 — handlePaymentSuccess capture-amount parity", () => {
  it("blocks confirmation + pages when the captured amount ≠ Payment.amount", async () => {
    await handlePaymentSuccess("order1", { appointmentType: "CONSULTATION" }, 9999);

    // Paged with the mismatch error.
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(String(captureException.mock.calls[0][0])).toContain(
      "Capture amount mismatch",
    );

    // Marked for manual recovery (and NOT a normal confirmation).
    expect(paymentUpdate).toHaveBeenCalledTimes(1);
    const update = paymentUpdate.mock.calls[0][0] as {
      data: { description?: string };
    };
    expect(update.data.description).toContain("REQUIRES_MANUAL_RECOVERY");

    // Returned before confirming the booking or doing any Phase-2 work.
    expect(appointmentFindUnique).not.toHaveBeenCalled();
    expect(createEarningsFromPayment).not.toHaveBeenCalled();
  });

  it("treats an exact match as no mismatch (guard does not fire)", async () => {
    // A matching capture must not produce the manual-recovery write or a page,
    // proving the guard is inert on the happy path. We stop the flow right after
    // the guard by having the tentative-appointment lookup short-circuit.
    appointmentFindUnique.mockResolvedValue(null); // flow throws after the guard
    await handlePaymentSuccess(
      "order1",
      { appointmentType: "CONSULTATION" },
      10000,
    ).catch(() => undefined); // we only assert the guard did not fire

    expect(captureException).not.toHaveBeenCalled();
    const recoveryWrite = paymentUpdate.mock.calls.find((c) =>
      String(
        (c[0] as { data?: { description?: string } })?.data?.description ?? "",
      ).includes("REQUIRES_MANUAL_RECOVERY"),
    );
    expect(recoveryWrite).toBeUndefined();
    // The guard let the flow proceed to the tentative-appointment lookup.
    expect(appointmentFindUnique).toHaveBeenCalled();
  });
});
