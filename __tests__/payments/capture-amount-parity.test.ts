/**
 * @jest-environment node
 */

/**
 * #677 / #990 — defence-in-depth capture-amount parity in handlePaymentSuccess.
 *
 * The gateway order is created at checkout for exactly Payment.amount and the
 * webhook is HMAC-verified, so a captured amount that differs is a gateway
 * anomaly or our-own bug. handlePaymentSuccess must NOT confirm the booking.
 * #990 changed the remediation: Phase 1 pages (Sentry, fatal) and stamps
 * REQUIRES_MANUAL_RECOVERY as a FALLBACK marker, then Phase 2 AUTO-REFUNDS the
 * wrong-amount capture via refundPayment and clears the marker. The manual
 * marker only survives if the refund call itself throws. Either way the booking
 * is never confirmed (no appointment lookup, no earnings, no Phase-2 confirm
 * work). The matching-amount happy path is inert on the guard.
 */

const captureException = jest.fn();
const captureMessage = jest.fn();
jest.mock("@sentry/nextjs", () => ({
  __esModule: true,
  captureException: (...a: unknown[]) => captureException(...a),
  captureMessage: (...a: unknown[]) => captureMessage(...a),
}));

const withSerializableRetry = jest.fn(async (fn: () => unknown) => fn());
jest.mock("../../lib/db/serializable-retry", () => ({
  __esModule: true,
  withSerializableRetry: (fn: () => unknown) => withSerializableRetry(fn),
}));

// #1439 — every in-tx status stamp is now a CAS, so the tx writer is
// `updateMany` and its count decides whether the flow continues.
const paymentUpdateMany = jest.fn(
  async (_args: {
    where: { paymentStatus?: string };
    data: { description?: string };
  }) => ({ count: 1 }),
);
const paymentFindUnique = jest.fn();
const appointmentFindUnique = jest.fn();
// #1695 — the trial CAS and the in-tx marker write; the occurrence read is
// the first thing confirmExistingAppointment does, so "never called" proves
// a released hold was not confirmed.
const trialUpdateMany = jest.fn(
  async (_args: { where: { id: string; status: string } }) => ({ count: 1 }),
);
const trialFindUnique = jest.fn();
const txPaymentUpdate = jest.fn(async () => ({}));
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
// #990 — the Phase-2 clear-marker write runs on the base client (outside the
// tx). Give it its own update mock so the auto-refund success path completes.
const prismaPaymentUpdate = jest.fn(
  async (_args: { where: unknown; data: { description?: string } }) => ({}),
);
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    $transaction: async (fn: (tx: unknown) => unknown) => fn(txStub),
    payment: {
      update: (...a: unknown[]) => prismaPaymentUpdate(...(a as [never])),
    },
  },
}));

// Side-effectful import graph — present only so the module loads; the mismatch
// branch returns before any of it runs.
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
const recordSystemError = jest.fn(
  async (_args: { context?: Record<string, unknown> }) => undefined,
);
jest.mock("../../lib/enterprise/system-events", () => ({
  recordSystemError: (...a: unknown[]) => recordSystemError(...(a as [never])),
}));
const validateWebhookMetadata = jest.fn();
jest.mock("../../schemas/webhooks/metadata", () => ({
  normalizeLegacySlotKeys: (m: unknown) => m,
  validateWebhookMetadata: (...a: unknown[]) => validateWebhookMetadata(...a),
}));

import {
  handlePaymentFailure,
  handlePaymentSuccess,
} from "../../lib/payments/webhooks/handlers";

beforeEach(() => {
  jest.clearAllMocks();
  paymentUpdateMany.mockImplementation(async () => ({ count: 1 }));
  validateWebhookMetadata.mockImplementation(() => undefined);
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

describe("#677 / #990 — handlePaymentSuccess capture-amount parity", () => {
  it("blocks confirmation, pages, and AUTO-REFUNDS when captured amount ≠ Payment.amount", async () => {
    refundPayment.mockResolvedValue({ id: "rfnd1" });

    await handlePaymentSuccess(
      "order1",
      { appointmentType: "CONSULTATION" },
      9999,
    );

    // Paged exactly once with the mismatch error (the fatal Phase-1 page). No
    // second page fires because the refund succeeds.
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(String(captureException.mock.calls[0][0])).toContain(
      "Capture amount mismatch",
    );

    // Phase 1 stamped the REQUIRES_MANUAL_RECOVERY fallback marker (in-tx),
    // and #1439 puts the PENDING predicate in the WHERE.
    expect(paymentUpdateMany).toHaveBeenCalledTimes(1);
    const update = paymentUpdateMany.mock.calls[0][0];
    expect(update.where.paymentStatus).toBe("PENDING");
    expect(update.data.description).toContain("REQUIRES_MANUAL_RECOVERY");

    // #990 — Phase 2 auto-refunded the wrong-amount capture for this payment.
    expect(refundPayment).toHaveBeenCalledTimes(1);
    expect(refundPayment.mock.calls[0][0]).toMatchObject({
      paymentId: "pay1",
      initiatedByUserId: null,
    });

    // …then cleared the fallback marker on the base client (refund succeeded).
    expect(prismaPaymentUpdate).toHaveBeenCalledTimes(1);
    expect(prismaPaymentUpdate.mock.calls[0][0].data.description).toContain(
      "Auto-refunded",
    );

    // Booking was never confirmed and no Phase-2 confirm work ran.
    expect(appointmentFindUnique).not.toHaveBeenCalled();
    expect(createEarningsFromPayment).not.toHaveBeenCalled();
  });

  it("keeps REQUIRES_MANUAL_RECOVERY + pages twice when the auto-refund itself fails", async () => {
    // #990 fallback: if refundPayment throws, the manual-recovery marker is NOT
    // cleared (no clear-marker write) and the refund failure is paged too.
    refundPayment.mockRejectedValue(new Error("gateway 500"));

    await handlePaymentSuccess(
      "order1",
      { appointmentType: "CONSULTATION" },
      9999,
    );

    // Two pages: the Phase-1 mismatch page + the Phase-2 refund-failure page.
    expect(captureException).toHaveBeenCalledTimes(2);
    expect(String(captureException.mock.calls[0][0])).toContain(
      "Capture amount mismatch",
    );

    // The REQUIRES_MANUAL_RECOVERY marker survives (clear-marker write skipped).
    expect(refundPayment).toHaveBeenCalledTimes(1);
    expect(prismaPaymentUpdate).not.toHaveBeenCalled();

    // Still no booking confirmation.
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
    const recoveryWrite = paymentUpdateMany.mock.calls.find((c) =>
      String(c[0].data.description ?? "").includes("REQUIRES_MANUAL_RECOVERY"),
    );
    expect(recoveryWrite).toBeUndefined();
    // The guard let the flow proceed to the tentative-appointment lookup.
    expect(appointmentFindUnique).toHaveBeenCalled();
  });
});

describe("#1695 — a capture whose hold is already gone is claimed and refunded, never confirmed", () => {
  it("claims an EXPIRED payment as SUCCEEDED by CAS and refunds through the front door", async () => {
    // The abandoned-payments sweep expired the row and released its hold; the
    // late capture is real money that funds nothing. #1439 used to report it
    // and stop, leaving the buyer charged with no booking and no refund.
    paymentFindUnique.mockResolvedValue({
      id: "pay1",
      paymentIntent: "order1",
      amount: 10000,
      paymentStatus: "EXPIRED",
      userId: "u1",
      currency: "INR",
      appointmentId: "appt1",
      user: { email: "buyer@example.com", name: "Buyer", consulteeProfile: {} },
    });
    refundBookingPayment.mockResolvedValue({ rail: "GATEWAY" });

    await handlePaymentSuccess("order1", { appointmentType: "CONSULTATION" });

    expect(paymentUpdateMany).toHaveBeenCalledTimes(1);
    expect(paymentUpdateMany.mock.calls[0][0]).toMatchObject({
      where: { paymentStatus: "EXPIRED" },
      data: { paymentStatus: "SUCCEEDED" },
    });
    expect(refundBookingPayment).toHaveBeenCalledWith(
      expect.objectContaining({ paymentId: "pay1", initiatedByUserId: null }),
    );
    expect(prismaPaymentUpdate.mock.calls[0][0].data.description).toContain(
      "Auto-refunded",
    );
    // Nothing was confirmed and nobody was paged for hand-work.
    expect(appointmentFindUnique).not.toHaveBeenCalled();
    expect(createEarningsFromPayment).not.toHaveBeenCalled();
    expect(recordSystemError).not.toHaveBeenCalled();
  });

  it("refunds a capture on a trial the unpaid-trial sweep already cancelled, without confirming its slot", async () => {
    appointmentFindUnique.mockResolvedValue({ id: "appt1" });
    trialUpdateMany.mockResolvedValue({ count: 0 });
    trialFindUnique.mockResolvedValue({ status: "CANCELLED" });
    refundBookingPayment.mockResolvedValue({ rail: "GATEWAY" });

    await handlePaymentSuccess("order1", {
      appointmentType: "TRIAL",
      trialId: "trial1",
    });

    expect(trialUpdateMany.mock.calls[0][0]).toMatchObject({
      where: { id: "trial1", status: "AWAITING_PAYMENT" },
    });
    expect(occurrenceFindMany).not.toHaveBeenCalled();
    expect(refundBookingPayment).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentId: "pay1",
        reason: expect.stringContaining("trial CANCELLED"),
      }),
    );
    expect(createEarningsFromPayment).not.toHaveBeenCalled();
  });
});

describe("#1582 B-P0-01 — handlePaymentFailure is a CAS write", () => {
  it("does not overwrite a row the capture won and never frees the hold", async () => {
    // The in-tx read still says PENDING, but by the time the write lands the
    // capture of a later attempt has set SUCCEEDED, so the CAS matches 0 rows.
    paymentFindUnique.mockResolvedValue({
      id: "pay1",
      paymentStatus: "PENDING",
      userId: "u1",
      appointmentId: "appt1",
      amount: 10000,
      currency: "INR",
      description: null,
      user: { email: "buyer@example.com", name: "Buyer" },
      appointment: { id: "appt1", appointmentType: "CONSULTATION" },
    });
    paymentUpdateMany.mockResolvedValue({ count: 0 });

    await handlePaymentFailure("order1");

    expect(paymentUpdateMany).toHaveBeenCalledTimes(1);
    expect(paymentUpdateMany.mock.calls[0][0].where).toMatchObject({
      id: "pay1",
      paymentStatus: "PENDING",
    });
    expect(txPaymentUpdate).not.toHaveBeenCalled();
    // cleanupFailedPaymentAppointment starts with the appointment read.
    expect(appointmentFindUnique).not.toHaveBeenCalled();
    expect(captureMessage).toHaveBeenCalledWith(
      "payment.failed lost the race to a capture",
      expect.anything(),
    );
  });
});
