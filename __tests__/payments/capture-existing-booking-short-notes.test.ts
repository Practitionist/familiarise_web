/**
 * @jest-environment node
 */

/**
 * A capture on a booking that already exists is confirmed from our rows: its
 * type and its trial come from the appointment, whatever the gateway notes
 * carry. The notes here are built by the real mint builders from what the
 * client really sends, or are empty, or name another booking.
 */

const withSerializableRetry = jest.fn(async (fn: () => unknown) => fn());
jest.mock("../../lib/db/serializable-retry", () => ({
  __esModule: true,
  withSerializableRetry: (fn: () => unknown) => withSerializableRetry(fn),
}));
jest.mock("@sentry/nextjs", () => ({
  __esModule: true,
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

const tx = {
  $executeRaw: jest.fn(async () => 0),
  payment: {
    findUnique: jest.fn(),
    update: jest.fn(async () => ({})),
    updateMany: jest.fn(async () => ({ count: 1 })),
    count: jest.fn(async () => 1),
  },
  appointment: { findUnique: jest.fn() },
  appointmentOccurrence: {
    findMany: jest.fn(async () => []),
    findFirst: jest.fn(async () => null),
    updateMany: jest.fn(async () => ({ count: 1 })),
  },
  appointmentParticipant: { findMany: jest.fn(async () => []) },
  consultantProfile: { findUnique: jest.fn(async () => null) },
  consultation: { findUnique: jest.fn() },
  subscription: { findUnique: jest.fn() },
  trial: { findUnique: jest.fn() },
};

/** The pre-transaction lookups read the same Payment row the transaction does. */
const globalPaymentFindUnique = jest.fn();
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    $transaction: async (fn: (t: unknown) => unknown) => fn(tx),
    payment: {
      findUnique: (...a: unknown[]) => globalPaymentFindUnique(...a),
      update: jest.fn(async () => ({})),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
    appointment: { findUnique: jest.fn(async () => null) },
    appointmentOccurrence: { findFirst: jest.fn(async () => null) },
  },
}));

// The gateway is never reached from a unit suite: a pin that wanders into an order read fails loudly.
const fetchRazorpayOrder = jest.fn(async () => {
  throw new Error("unit suite reached the gateway");
});
jest.mock("../../lib/payments/core/razorpay", () => ({
  __esModule: true,
  sanitizeRazorpayNotes: jest.requireActual("../../lib/payments/core/razorpay")
    .sanitizeRazorpayNotes,
  fetchRazorpayOrder: (...a: unknown[]) => fetchRazorpayOrder(...(a as [])),
}));

const createEarningsFromPayment = jest.fn(
  async (..._a: unknown[]) => undefined,
);
const planEarningsForPayment = jest.fn(
  async (..._a: unknown[]): Promise<unknown> => null,
);
const resolvePaymentForEarnings = jest.fn(async (..._a: unknown[]) => ({
  paymentForEarnings: { id: "pay1" },
  earningsAppointmentType: "SUBSCRIPTION",
  consultantProfileId: "consultant-profile-1",
}));
jest.mock("../../lib/payments/payouts", () => ({
  __esModule: true,
  createEarningsFromPayment: (...a: unknown[]) =>
    createEarningsFromPayment(...a),
  planEarningsForPayment: (...a: unknown[]) => planEarningsForPayment(...a),
  resolvePaymentForEarnings: (...a: unknown[]) =>
    resolvePaymentForEarnings(...a),
  reverseEarningsForPayment: jest.fn(),
}));
const postUnappliedReceipt = jest.fn(async () => undefined);
jest.mock("../../lib/payments/ledger/unapplied-receipts", () => ({
  __esModule: true,
  postUnappliedReceipt: (...a: unknown[]) => postUnappliedReceipt(...(a as [])),
  releaseUnappliedReceipt: jest.fn(async () => undefined),
}));
const transitionTrial = jest.fn(async () => undefined);
jest.mock("../../lib/booking/transitions", () => ({
  __esModule: true,
  REQUEST_ALLOWED_FROM: {},
  transitionClassEvent: jest.fn(),
  transitionConsultationRequest: jest.fn(async () => undefined),
  transitionOccurrenceCompletion: jest.fn(),
  transitionSubscriptionRequest: jest.fn(),
  transitionTrial: (...a: unknown[]) => transitionTrial(...(a as [])),
  transitionWebinarEvent: jest.fn(),
}));
const transitionParticipant = jest.fn(async () => 1);
jest.mock("../../lib/booking/participants", () => ({
  ...jest.requireActual("../../lib/booking/participants"),
  transitionParticipant: (...a: unknown[]) =>
    transitionParticipant(...(a as [])),
}));
jest.mock("../../lib/booking/backup-interest", () => ({
  __esModule: true,
  markAppointmentWindowsBooked: jest.fn(async () => undefined),
}));
jest.mock("../../lib/trials/conversion", () => ({
  __esModule: true,
  convertCompletedTrial: jest.fn(async () => undefined),
}));
jest.mock("../../lib/referrals/capture", () => ({
  __esModule: true,
  recordReferralCaptureInSavepoint: jest.fn(async () => undefined),
}));
jest.mock("../../lib/referrals/referral-notify", () => ({
  __esModule: true,
  readCreditsApplied: jest.fn(async () => null),
  prepareCreditsAppliedEmail: jest.fn(async () => null),
  stageCreditsApplied: jest.fn(async () => ({})),
}));
jest.mock("../../lib/referrals/service", () => ({ __esModule: true }));
jest.mock("../../lib/payments/webhooks/staged-emails", () => ({
  __esModule: true,
  loadAppointmentForEmails: jest.fn(async () => null),
  prepareBookedEmails: jest.fn(),
  preparePaymentFailedEmail: jest.fn(),
  preparePaymentSuccessEmail: jest.fn(),
  resolveAppointmentNotificationContext: jest.fn(async () => null),
  stageBookedEmails: jest.fn(),
  stagePaymentFailedEmail: jest.fn(),
  stagePaymentSuccessBells: jest.fn(),
  stagePaymentSuccessEmail: jest.fn(),
}));
const createAppointmentFromWebhook = jest.fn();
jest.mock("../../lib/payments/webhooks/legacy-appointment-creation", () => ({
  __esModule: true,
  createAppointmentFromWebhook: (...a: unknown[]) =>
    createAppointmentFromWebhook(...a),
  RecoveryAlreadyDoneError: class extends Error {},
  RecoveryRefusedError: class extends Error {},
}));
jest.mock("../../lib/payments/billing/consumer-invoice", () => ({
  __esModule: true,
  mintConsumerInvoiceBestEffort: jest.fn(async () => undefined),
}));
jest.mock("../../lib/payments/webhooks/ensure-channels", () => ({
  __esModule: true,
  ensureChannelsForAppointment: jest.fn(async () => ({ ensured: true })),
}));
jest.mock("../../lib/payments/operations/refund", () => ({
  __esModule: true,
  refundPayment: jest.fn(),
}));
jest.mock("../../lib/email", () => ({
  __esModule: true,
  attempt: jest.fn(),
  attemptStaged: jest.fn(),
  EMAIL_BUDGET_MS: { WEBHOOK: 1 },
}));
jest.mock("../../lib/novu", () => ({
  __esModule: true,
  attemptTrigger: jest.fn(),
  notifyPaymentSuccess: jest.fn(),
  notifyPaymentFailed: jest.fn(),
  notifyAppointmentBooked: jest.fn(),
  notifyTrialCancelled: jest.fn(),
}));
jest.mock("../../lib/stream-logger", () => ({
  __esModule: true,
  streamLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock("../../lib/enterprise/system-events", () => ({
  __esModule: true,
  recordSystemError: () => Promise.resolve(),
  recordSystemErrorSafe: () => Promise.resolve(),
}));

import { AppointmentsType, TrialStatus } from "@prisma/client";

import { handlePaymentSuccess } from "../../lib/payments/webhooks/handlers";
import { buildPaymentMetadata } from "../../lib/payments/checkout/schema";
import { buildApprovalMetadata } from "../../lib/payments/operations/approval-payment";
import { sanitizeRazorpayNotes } from "../../lib/payments/core/razorpay";
import { checkoutSchema, createCheckoutData } from "../../schemas/checkout";

const BUYER = "buyerUserId00000000000000000001";
const PLAN = "clw1111111111111111111111";
const TRIAL = "clw2222222222222222222222";
const OTHER_TRIAL = "clw4444444444444444444444";
const RENEWED = "clw3333333333333333333333";
const HOUR_MS = 60 * 60 * 1000;
const FUTURE = new Date(Date.now() + 72 * HOUR_MS);

type BookedType = "SUBSCRIPTION" | "CONSULTATION" | "TRIAL";

/** The gateway notes the checkout mint sends for this client payload. */
function checkoutNotes(
  client: Parameters<typeof createCheckoutData>[0],
): Record<string, string> {
  const validated = checkoutSchema.parse(createCheckoutData(client));
  const notes = sanitizeRazorpayNotes(buildPaymentMetadata(validated, BUYER));
  if (!notes) throw new Error("no notes");
  return notes;
}

/** The subscription hook's payload: the period start, and a renewal source when renewing. */
const subscriptionNotes = (extra: { renewsSubscriptionId?: string } = {}) =>
  checkoutNotes({
    appointmentType: AppointmentsType.SUBSCRIPTION,
    planId: PLAN,
    paymentGateway: "RAZORPAY",
    schedulingPeriodStartsAt: FUTURE.toISOString(),
    ...extra,
  });

/** What `mintTrialRequestOrder` passes to the approval mint: no slot times. */
const trialRequestNotes = () =>
  sanitizeRazorpayNotes({
    familiarisePaymentId: "pay1",
    ...buildApprovalMetadata(
      {
        userId: BUYER,
        appointmentType: "TRIAL",
        trialId: TRIAL,
        appointmentId: "appt-1",
        planId: PLAN,
        paymentGateway: "RAZORPAY",
      },
      { taxAmount: 0 },
    ),
  }) as Record<string, string>;

/**
 * One PENDING Payment row, as the global lookups and the transaction read it.
 * `booked` is the linked appointment's type; null is a payment with no booking yet.
 */
function primePayment(booked: BookedType | null) {
  const row = {
    id: "pay1",
    paymentIntent: "order_1",
    amount: 599400,
    currency: "INR",
    paymentStatus: "PENDING",
    gatewayPaymentId: null,
    userId: BUYER,
    appointmentId: booked ? "appt-1" : null,
    appointment: booked ? { appointmentType: booked } : null,
    expiresAt: null,
    capturedAt: null,
    createdAt: new Date(),
    user: {
      id: BUYER,
      email: "b@x.com",
      name: "Buyer",
      consulteeProfile: null,
    },
  };
  globalPaymentFindUnique.mockResolvedValue(row);
  tx.payment.findUnique.mockResolvedValue(row);
}

/** The appointment row every in-transaction read of it sees. */
function primeAppointment(kind: BookedType, opts: { trial?: boolean } = {}) {
  tx.appointment.findUnique.mockResolvedValue({
    id: "appt-1",
    appointmentType: kind,
    trial: kind === "TRIAL" && opts.trial !== false ? { id: TRIAL } : null,
    consultation:
      kind === "CONSULTATION"
        ? {
            id: "cons-1",
            consultationPlan: { consultantProfileId: "consultant-profile-1" },
          }
        : null,
    subscription:
      kind === "SUBSCRIPTION"
        ? {
            id: "sub-1",
            subscriptionPlan: { consultantProfileId: "consultant-profile-1" },
          }
        : null,
    webinar: null,
    class: null,
  });
}

function primeBooking(kind: BookedType, opts: { trial?: boolean } = {}) {
  primePayment(kind);
  primeAppointment(kind, opts);
}

const stampDescriptions = () =>
  tx.payment.updateMany.mock.calls.map(
    (call) =>
      (call as unknown as [{ data: { description?: string } }])[0].data
        .description,
  );

/** The capture confirmed: SUCCEEDED with no marker, nothing parked, the booking journal posted. */
function expectConfirmed(outcome: unknown) {
  expect(outcome).toBe("confirmed");
  expect(tx.payment.updateMany).toHaveBeenCalledWith({
    where: { id: "pay1", paymentStatus: "PENDING" },
    data: expect.objectContaining({ paymentStatus: "SUCCEEDED" }),
  });
  expect(stampDescriptions()).toEqual([undefined]);
  expect(postUnappliedReceipt).not.toHaveBeenCalled();
  expect(createEarningsFromPayment).toHaveBeenCalledWith(
    expect.objectContaining({ tx }),
  );
  expect(createAppointmentFromWebhook).not.toHaveBeenCalled();
  expectNoGatewayRead();
}

/** The pin went through the existing-payment path, never the pre-mint adoption read. */
function expectNoGatewayRead() {
  expect(fetchRazorpayOrder).not.toHaveBeenCalled();
}

/** The trial the capture moved on, and the type the earnings were resolved for. */
function expectTrialScheduled(trialId: string) {
  expect(transitionTrial).toHaveBeenCalledWith(
    tx,
    expect.objectContaining({
      where: { id: trialId },
      to: TrialStatus.SCHEDULED,
      fromIn: [TrialStatus.AWAITING_PAYMENT],
      data: expect.objectContaining({ paymentId: "pay1" }),
    }),
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
  tx.subscription.findUnique.mockResolvedValue({ status: "PENDING" });
  tx.consultation.findUnique.mockResolvedValue({
    id: "cons-1",
    status: "PENDING",
  });
});

afterEach(() => jest.restoreAllMocks());

describe("a capture on a booking that already exists", () => {
  it("confirms a subscription whose minted notes carry the period start and no end", async () => {
    const notes = subscriptionNotes();
    expect(notes.schedulingPeriodStartsAt).toBeDefined();
    expect(notes).not.toHaveProperty("schedulingPeriodEndsAt");
    primeBooking("SUBSCRIPTION");

    expectConfirmed(
      await handlePaymentSuccess("order_1", notes, 599400, "pay_1"),
    );
    // The booking confirmed: its tentative slots hardened and its seat moved.
    expect(tx.appointmentOccurrence.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { isTentative: false } }),
    );
    expect(transitionParticipant).toHaveBeenCalledWith(
      tx,
      { appointmentId: "appt-1", status: "HELD" },
      "CONFIRMED",
    );
  });

  it.each([
    [
      "the start only",
      () => subscriptionNotes({ renewsSubscriptionId: RENEWED }),
    ],
    [
      "neither period key",
      () => {
        const notes = subscriptionNotes({ renewsSubscriptionId: RENEWED });
        delete notes.schedulingPeriodStartsAt;
        return notes;
      },
    ],
  ])("confirms a renewal whose notes carry %s", async (_shape, build) => {
    const notes = build();
    expect(notes).not.toHaveProperty("schedulingPeriodEndsAt");
    primeBooking("SUBSCRIPTION");

    expectConfirmed(
      await handlePaymentSuccess("order_1", notes, 599400, "pay_1"),
    );
  });

  it("confirms a request-time trial order and moves the trial to SCHEDULED", async () => {
    const notes = trialRequestNotes();
    expect(notes).not.toHaveProperty("startsAt");
    primeBooking("TRIAL");

    expectConfirmed(
      await handlePaymentSuccess("order_1", notes, 599400, "pay_1"),
    );
    expectTrialScheduled(TRIAL);
  });

  it.each<BookedType>(["SUBSCRIPTION", "CONSULTATION"])(
    "confirms a %s capture whose notes are empty",
    async (kind) => {
      primeBooking(kind);

      expectConfirmed(
        await handlePaymentSuccess("order_1", {}, 599400, "pay_1"),
      );
      expect(planEarningsForPayment).toHaveBeenCalledWith(
        { paymentIntent: "order_1" },
        expect.any(Date),
        kind,
      );
      expect(resolvePaymentForEarnings).toHaveBeenCalledWith(
        { id: "pay1" },
        kind,
        tx,
      );
      expect(transitionTrial).not.toHaveBeenCalled();
    },
  );

  it("confirms a trial capture whose notes are empty and moves the booked trial", async () => {
    primeBooking("TRIAL");

    expectConfirmed(await handlePaymentSuccess("order_1", {}, 599400, "pay_1"));
    expect(resolvePaymentForEarnings).toHaveBeenCalledWith(
      { id: "pay1" },
      "TRIAL",
      tx,
    );
    expectTrialScheduled(TRIAL);
  });

  it("confirms the booked trial when the notes name another type and trial", async () => {
    primeBooking("TRIAL");

    expectConfirmed(
      await handlePaymentSuccess(
        "order_1",
        { appointmentType: "CONSULTATION", trialId: OTHER_TRIAL },
        599400,
        "pay_1",
      ),
    );
    expectTrialScheduled(TRIAL);
    expect(transitionTrial).not.toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ where: { id: OTHER_TRIAL } }),
    );
    expect(resolvePaymentForEarnings).toHaveBeenCalledWith(
      { id: "pay1" },
      "TRIAL",
      tx,
    );
  });

  it("moves no trial for a subscription whose notes name one", async () => {
    primeBooking("SUBSCRIPTION");

    expectConfirmed(
      await handlePaymentSuccess(
        "order_1",
        { ...subscriptionNotes(), trialId: OTHER_TRIAL },
        599400,
        "pay_1",
      ),
    );
    expect(transitionTrial).not.toHaveBeenCalled();
  });

  it("drops an earnings forecast made for another type than the booking's", async () => {
    // The pre-transaction read saw no booking, so the forecast followed the notes.
    primeBooking("SUBSCRIPTION");
    globalPaymentFindUnique.mockResolvedValue({
      ...(await tx.payment.findUnique()),
      appointment: null,
    });
    planEarningsForPayment.mockResolvedValueOnce({
      resolvedPayment: {
        paymentForEarnings: { id: "pay1" },
        earningsAppointmentType: "CONSULTATION",
        consultantProfileId: "consultant-profile-1",
      },
    });

    expectConfirmed(
      await handlePaymentSuccess(
        "order_1",
        { appointmentType: "CONSULTATION" },
        599400,
        "pay_1",
      ),
    );
    expect(resolvePaymentForEarnings).toHaveBeenCalledWith(
      { id: "pay1" },
      "SUBSCRIPTION",
      tx,
    );
    expect(createEarningsFromPayment).toHaveBeenCalledWith(
      expect.objectContaining({ preplanned: undefined }),
    );
  });

  it("parks a trial booking that has no trial, saying so", async () => {
    primeBooking("TRIAL", { trial: false });

    expect(
      await handlePaymentSuccess(
        "order_1",
        trialRequestNotes(),
        599400,
        "pay_1",
      ),
    ).toBeNull();
    expect(stampDescriptions()).toEqual([
      "REQUIRES_MANUAL_RECOVERY: Trial booking appt-1 has no trial. Customer charged but booking NOT confirmed.",
    ]);
    expect(postUnappliedReceipt).toHaveBeenCalledTimes(1);
    expect(transitionTrial).not.toHaveBeenCalled();
    expect(createEarningsFromPayment).not.toHaveBeenCalled();
    expectNoGatewayRead();
  });
});

describe("a capture with no booking yet", () => {
  it("still parks the same short subscription notes: the create path needs the period", async () => {
    // The Payment row exists and has no booking: the create path, not a pre-mint adoption.
    primePayment(null);

    expect(
      await handlePaymentSuccess(
        "order_1",
        subscriptionNotes(),
        599400,
        "pay_1",
      ),
    ).toBeNull();
    expect(stampDescriptions()[0]).toMatch(
      /^REQUIRES_MANUAL_RECOVERY: Metadata validation failed: .*Customer charged but appointment NOT created\.$/,
    );
    expect(postUnappliedReceipt).toHaveBeenCalledTimes(1);
    expect(createAppointmentFromWebhook).not.toHaveBeenCalled();
    expect(createEarningsFromPayment).not.toHaveBeenCalled();
    expectNoGatewayRead();
  });
});
