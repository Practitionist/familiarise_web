/**
 * @jest-environment node
 */

/**
 * #677 / #990 — defence-in-depth capture-amount parity in handlePaymentSuccess.
 *
 * The gateway order is created at checkout for exactly Payment.amount and the
 * webhook is HMAC-verified, so a captured amount that differs is a gateway
 * anomaly or our-own bug. handlePaymentSuccess must NOT confirm the booking.
 * #990 changed the remediation: Phase 1 pages (Sentry, fatal) and stamps the
 * auto-refund marker, then Phase 2 AUTO-REFUNDS the wrong-amount capture via
 * refundPayment and settles the marker. The pending marker only survives if
 * the refund call itself throws, and #1846 N2's retry sweep then re-drives it. Either way the booking
 * is never confirmed (no appointment lookup, no earnings, no Phase-2 confirm
 * work). The matching-amount happy path is inert on the guard.
 *
 * W1b — ORDERING CHANGED, and this paragraph used to be the only description
 * of it. The parity comparison now runs BEFORE the `SUCCEEDED → return null`
 * short-circuit, so a webhook REDELIVERY of an already-confirmed payment still
 * re-validates the captured amount; a mismatch on a terminal row pages P1 and
 * logs `*_MISMATCH_REDELIVERY` but performs no second remediation. Without the
 * hoist a mismatched redelivery returned at the short-circuit and the mismatch
 * was never examined at all. The `EXPIRED`/`FAILED` claim was hoisted above it
 * too; the two predicates are mutually exclusive, so its behaviour is unchanged.
 * See `capture-amount-parity-plumbing.test.ts` for the redelivery pins.
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
const reverseCreditsForPayment = jest.fn();
jest.mock("../../lib/referrals/service", () => ({
  reverseCreditsForPayment: (...a: unknown[]) => reverseCreditsForPayment(...a),
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
jest.mock("../../lib/enterprise/system-events", () => {
  return {
    recordSystemError: (...a: unknown[]) =>
      recordSystemError(...(a as [never])),
    recordSystemErrorSafe: (...a: unknown[]) =>
      recordSystemError(...(a as [never])),
  };
});
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

    // Phase 1 stamped the pending auto-refund marker (in-tx, #1846 N2),
    // and #1439 puts the PENDING predicate in the WHERE.
    expect(paymentUpdateMany).toHaveBeenCalledTimes(1);
    const update = paymentUpdateMany.mock.calls[0][0];
    expect(update.where.paymentStatus).toBe("PENDING");
    expect(update.data.description).toMatch(/^Auto-refund pending:/);

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

  it("keeps the pending marker + pages twice when the auto-refund itself fails", async () => {
    // #990 fallback: if refundPayment throws, the pending marker is NOT
    // settled (no settle write) and the refund failure is paged too.
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

    // The pending marker survives (settle write skipped) for the retry sweep.
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
      String(c[0].data.description ?? "").startsWith("Auto-refund pending:"),
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

    // #1846 SM-B13 — the CAS now rides transitionTrial's from-set.
    expect(trialUpdateMany.mock.calls[0][0]).toMatchObject({
      where: { id: "trial1", status: { in: ["AWAITING_PAYMENT"] } },
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
    expect(reverseCreditsForPayment).not.toHaveBeenCalled();
  });

  it("restores the order's credits inside the transaction that wins PENDING → FAILED", async () => {
    paymentFindUnique.mockResolvedValue({
      id: "pay1",
      paymentStatus: "PENDING",
      userId: "u1",
      appointmentId: null,
      amount: 10000,
      currency: "INR",
      description: null,
      user: { email: "buyer@example.com", name: "Buyer" },
      appointment: null,
    });

    await handlePaymentFailure("order1").catch(() => undefined);

    expect(reverseCreditsForPayment).toHaveBeenCalledWith("pay1", txStub);
  });
});

describe("#1582 B-P1-02 — in-tx system events ride the transaction client", () => {
  it("a capture that loses the EXPIRED→SUCCEEDED claim records CAPTURE_AFTER_TERMINAL through tx", async () => {
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
    // The CAS on EXPIRED misses: another writer moved the row first.
    paymentUpdateMany.mockResolvedValue({ count: 0 });

    await handlePaymentSuccess(
      "order1",
      { appointmentType: "CONSULTATION" },
      10000,
    );

    expect(recordSystemError).toHaveBeenCalledTimes(1);
    const params = recordSystemError.mock.calls[0][0] as {
      db?: unknown;
      err?: Error;
    };
    // The prisma mock records the client: it is the tx stub, not the global.
    expect(params.db).toBe(txStub);
    expect(params.err?.message).toBe("CAPTURE_AFTER_TERMINAL_PAYMENT");
  });
});
