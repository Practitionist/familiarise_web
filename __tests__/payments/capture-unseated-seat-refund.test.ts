/**
 * @jest-environment node
 */

/**
 * A capture that lands on a webinar/class seat which is no longer there.
 *
 * The defect this pins: `leaveEventSeat` releases the seat in its own
 * transaction and only THEN calls the seat refund, which resolves the seat's
 * payment with `paymentStatus: "SUCCEEDED"`. A buyer who left before their card
 * captured therefore had nothing refunded at that instant — correct — and then
 * the capture arrived, `restampLiveEvent` passed (the event wrapper is still
 * live), the participant CAS matched zero rows, the matched count was
 * discarded, and the handler reported a successful confirmation. The buyer's
 * money was captured, the seat was gone, nothing was written down, and no sweep
 * looks for a SUCCEEDED payment whose seat is not live.
 *
 * Three cases the CAS count now distinguishes, plus the fourth the legacy
 * group-event creators needed:
 *
 *   - CONFIRMED/ATTENDED → a redelivered capture, the no-op it always was;
 *   - CANCELLED/REFUNDED → the seat is gone: refund THIS capture by intent;
 *   - no row at all → the same answer for the buyer, recorded distinctly;
 *   - a legacy capture for a FULL event → no seat is created, and the capture
 *     is refunded instead of overselling the room.
 */

const withSerializableRetry = jest.fn(async (fn: () => unknown) => fn());
jest.mock("../../lib/db/serializable-retry", () => ({
  __esModule: true,
  withSerializableRetry: (fn: () => unknown) => withSerializableRetry(fn),
}));

const captureException = jest.fn();
jest.mock("@sentry/nextjs", () => ({
  __esModule: true,
  captureException: (...a: unknown[]) => captureException(...a),
  captureMessage: jest.fn(),
}));

// ---- the Phase-1 transaction stub -------------------------------------------------
const paymentFindUnique = jest.fn();
const paymentUpdate = jest.fn().mockResolvedValue({});
const paymentUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
const appointmentFindUnique = jest.fn();
const participantUpdateMany = jest.fn();
const participantFindFirst = jest.fn();
const systemEventFindFirst = jest.fn().mockResolvedValue(null);
const webinarFindUnique = jest.fn();
const webinarUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
const classFindUnique = jest.fn();
const classUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
const historyCreate = jest.fn().mockResolvedValue({});
const participantCreateMany = jest.fn().mockResolvedValue({ count: 1 });

const txStub = {
  $executeRaw: jest.fn(async () => 0),
  payment: {
    findUnique: paymentFindUnique,
    update: paymentUpdate,
    updateMany: paymentUpdateMany,
  },
  appointment: { findUnique: appointmentFindUnique, update: jest.fn() },
  appointmentParticipant: {
    createMany: participantCreateMany,
    updateMany: participantUpdateMany,
    findMany: jest.fn().mockResolvedValue([]),
    findFirst: participantFindFirst,
  },
  appointmentOccurrence: {
    findMany: jest.fn().mockResolvedValue([]),
    findFirst: jest.fn().mockResolvedValue(null),
    updateMany: jest.fn().mockResolvedValue({ count: 0 }),
  },
  systemEvent: { findFirst: systemEventFindFirst },
  webinar: { findUnique: webinarFindUnique, updateMany: webinarUpdateMany },
  class: { findUnique: classFindUnique, updateMany: classUpdateMany },
  bookingStatusHistory: { create: historyCreate },
};

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    $transaction: async (fn: (tx: unknown) => unknown) => fn(txStub),
    payment: {
      update: jest.fn().mockResolvedValue({}),
      // `settleAutoRefundMarker` reads first: null ends it without a write.
      findUnique: jest.fn().mockResolvedValue(null),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    // Phase 2's notification read; null keeps the plan name on its fallback.
    appointment: { findUnique: jest.fn().mockResolvedValue(null) },
    appointmentOccurrence: { findFirst: jest.fn().mockResolvedValue(null) },
  },
}));

jest.mock("../../lib/payments/billing/consumer-invoice", () => ({
  __esModule: true,
  mintConsumerInvoiceBestEffort: jest
    .fn()
    .mockResolvedValue({ consumerInvoiceId: null }),
}));
jest.mock("../../lib/payments/webhooks/ensure-channels", () => ({
  __esModule: true,
  ensureChannelsForAppointment: jest.fn().mockResolvedValue({ ensured: true }),
}));

const refundPayment = jest.fn().mockResolvedValue({ refundId: "rfnd-1" });
jest.mock("../../lib/payments/operations/refund", () => ({
  __esModule: true,
  refundPayment: (...a: unknown[]) => refundPayment(...a),
}));

const refundBookingPayment = jest
  .fn()
  .mockResolvedValue({ refundId: "rfnd-2" });
jest.mock("../../lib/payments/operations/booking-refund", () => ({
  __esModule: true,
  refundBookingPayment: (...a: unknown[]) => refundBookingPayment(...a),
}));

const getWebinarCapacity = jest.fn();
const getClassCapacity = jest.fn();
jest.mock("../../lib/events/capacity", () => ({
  __esModule: true,
  getWebinarCapacity: (...a: unknown[]) => getWebinarCapacity(...a),
  getClassCapacity: (...a: unknown[]) => getClassCapacity(...a),
}));

const recordSystemErrorSafe = jest.fn().mockResolvedValue(undefined);
jest.mock("../../lib/enterprise/system-events", () => ({
  __esModule: true,
  recordSystemError: jest.fn().mockResolvedValue(undefined),
  recordSystemErrorSafe: (...a: unknown[]) => recordSystemErrorSafe(...a),
}));

jest.mock("../../lib/payments/payouts", () => ({
  __esModule: true,
  createEarningsFromPayment: jest.fn(),
  planEarningsForPayment: jest.fn(async () => null),
  resolvePaymentForEarnings: jest.fn().mockResolvedValue(null),
}));
jest.mock("../../lib/email", () => ({
  __esModule: true,
  attempt: jest.fn(),
  attemptStaged: jest.fn(),
  stage: jest.fn(),
  stageAppointmentBookedEmail: jest.fn(),
  renderPaymentFailedEmail: jest.fn(),
  renderPaymentSuccessEmail: jest.fn(),
  EMAIL_BUDGET_MS: { WEBHOOK: 1 },
}));
jest.mock("../../lib/novu", () => ({
  __esModule: true,
  attemptTrigger: jest.fn(),
  notifyPaymentSuccess: jest.fn(),
  notifyPaymentFailed: jest.fn(),
  notifyAppointmentBooked: jest.fn(),
}));
jest.mock("../../lib/referrals/service", () => ({
  __esModule: true,
}));
jest.mock("../../lib/stream-logger", () => ({
  __esModule: true,
  streamLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock("../../schemas/webhooks/metadata", () => ({
  __esModule: true,
  normalizeLegacySlotKeys: (m: unknown) => m,
  validateWebhookMetadata: jest.fn(),
}));

import {
  confirmExistingAppointment,
  handlePaymentSuccess,
} from "../../lib/payments/webhooks/handlers";
import prisma from "../../lib/prisma";
import { validateWebhookMetadata } from "../../schemas/webhooks/metadata";

const markerRow = prisma.payment.findUnique as unknown as jest.Mock;
const markerSettle = prisma.payment.updateMany as unknown as jest.Mock;

const BUYER = "user-1";
const WEBINAR = "web-1";
const APPOINTMENT = "appt-web-1";

const WEBINAR_METADATA = {
  appointmentType: "WEBINAR",
  userId: BUYER,
  planId: "plan-1",
  eventId: WEBINAR,
};
const CLASS_METADATA = {
  appointmentType: "CLASS",
  userId: BUYER,
  planId: "plan-1",
  eventId: "class-1",
};

/** The NEW-FLOW shape: checkout created the seat, so the payment is linked. */
function pendingSeatPayment(over: Record<string, unknown> = {}) {
  return {
    id: "pay-1",
    paymentIntent: "order-1",
    amount: 10000,
    paymentStatus: "PENDING",
    userId: BUYER,
    currency: "INR",
    expiresAt: null,
    appointmentId: APPOINTMENT,
    user: {
      id: BUYER,
      email: "b@x.com",
      name: "Buyer",
      consulteeProfile: { id: "consultee-1" },
    },
    ...over,
  };
}

function liveWebinarAppointment() {
  return {
    id: APPOINTMENT,
    consultation: null,
    subscription: null,
    class: null,
    webinar: { id: WEBINAR },
  };
}

/** Legacy creators read the event, not the appointment the capture confirms. */
function liveWebinarRow(over: Record<string, unknown> = {}) {
  return {
    id: WEBINAR,
    status: "SCHEDULED",
    maxParticipants: null,
    webinarPlan: {
      maxParticipants: 10,
      consultantProfile: { userId: "host-1" },
    },
    appointment: {
      id: APPOINTMENT,
      occurrences: [{ id: "occ-1" }],
      participants: [{ userId: "someone-else" }],
    },
    ...over,
  };
}

function liveClassRow(over: Record<string, unknown> = {}) {
  return {
    id: "class-1",
    status: "SCHEDULED",
    maxParticipants: null,
    classPlan: {
      maxParticipants: 10,
      consultantProfile: { userId: "host-1" },
    },
    appointment: {
      id: APPOINTMENT,
      occurrences: [{ id: "occ-1" }],
      participants: [{ userId: "someone-else" }],
    },
    ...over,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  paymentUpdate.mockResolvedValue({});
  paymentUpdateMany.mockResolvedValue({ count: 1 });
  historyCreate.mockResolvedValue({});
  participantCreateMany.mockResolvedValue({ count: 1 });
  systemEventFindFirst.mockResolvedValue(null);
  webinarUpdateMany.mockResolvedValue({ count: 1 });
  classUpdateMany.mockResolvedValue({ count: 1 });
  // A capture that finds its seat: the CAS promotes the HELD row.
  participantUpdateMany.mockResolvedValue({ count: 1 });
  participantFindFirst.mockResolvedValue(null);
  recordSystemErrorSafe.mockResolvedValue(undefined);
  refundPayment.mockResolvedValue({ refundId: "rfnd-1" });
  refundBookingPayment.mockResolvedValue({ refundId: "rfnd-2" });
  getWebinarCapacity.mockReturnValue({
    max: 10,
    registered: 1,
    remaining: 9,
    isFull: false,
  });
  getClassCapacity.mockReturnValue({
    max: 10,
    registered: 1,
    remaining: 9,
    isFull: false,
  });
  webinarFindUnique.mockResolvedValue({
    status: "SCHEDULED",
    appointment: { id: APPOINTMENT },
  });
  classFindUnique.mockResolvedValue({
    status: "SCHEDULED",
    appointment: { id: APPOINTMENT, deletedAt: null },
  });
  appointmentFindUnique.mockResolvedValue(liveWebinarAppointment());
  paymentFindUnique.mockResolvedValue(pendingSeatPayment());
  (validateWebhookMetadata as jest.Mock).mockReturnValue(WEBINAR_METADATA);
});

// ---------------------------------------------------------------------------
// Part A — the seat CAS count, read instead of discarded.
// ---------------------------------------------------------------------------
describe("a capture whose seat is not there any more", () => {
  it("a RELEASED seat is reported and THIS capture is refunded by intent", async () => {
    participantUpdateMany.mockResolvedValue({ count: 0 });
    participantFindFirst.mockResolvedValue({
      id: "part-1",
      status: "CANCELLED",
      paymentId: "pay-1",
    });
    paymentFindUnique.mockResolvedValue(pendingSeatPayment());

    const outcome = await handlePaymentSuccess(
      "order-1",
      WEBINAR_METADATA as unknown as Record<string, string>,
      10000,
    );

    expect(outcome).toBe("confirmed");
    // The seat CAS was attempted exactly once, on the HELD seat — and its zero
    // count is what routed the capture to a refund rather than a quiet success.
    expect(participantUpdateMany).toHaveBeenCalledTimes(1);
    expect(participantUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          AND: expect.arrayContaining([
            expect.objectContaining({ userId: BUYER, status: "HELD" }),
          ]),
        }),
        data: { status: "CONFIRMED" },
      }),
    );
    expect(refundBookingPayment).toHaveBeenCalledTimes(1);
    expect(refundBookingPayment).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentId: "pay-1",
        dedupeKey: "capture-unseated:pay-1",
      }),
    );
    // The generic door is the org-unaware one; a released SEAT must not use it.
    expect(refundPayment).not.toHaveBeenCalled();
    // The durable ops row rides the transaction that decided the refund.
    expect(recordSystemErrorSafe).toHaveBeenCalledWith(
      expect.objectContaining({
        db: txStub,
        err: expect.objectContaining({ message: "CAPTURE_AFTER_SEAT_RELEASE" }),
        context: expect.objectContaining({
          participantId: "part-1",
          seatStatus: "CANCELLED",
          seatPaymentId: "pay-1",
        }),
      }),
    );
    // The marker is what retry-auto-refunds re-drives if the refund dies.
    expect(paymentUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          description: expect.stringContaining(
            "Auto-refund pending: capture landed after the seat was released",
          ),
        }),
      }),
    );
  });

  it("a second delivery of the same capture refunds nothing again", async () => {
    participantUpdateMany.mockResolvedValue({ count: 0 });
    participantFindFirst.mockResolvedValue({
      id: "part-1",
      status: "CANCELLED",
      paymentId: "pay-1",
    });
    // First delivery finds the row PENDING and claims it; the redelivery finds
    // it SUCCEEDED, which is the idempotency short-circuit.
    paymentFindUnique
      .mockResolvedValueOnce(pendingSeatPayment())
      .mockResolvedValue(pendingSeatPayment({ paymentStatus: "SUCCEEDED" }));

    await handlePaymentSuccess(
      "order-1",
      WEBINAR_METADATA as unknown as Record<string, string>,
      10000,
    );
    const replay = await handlePaymentSuccess(
      "order-1",
      WEBINAR_METADATA as unknown as Record<string, string>,
      10000,
    );

    expect(replay).toBeNull();
    expect(refundBookingPayment).toHaveBeenCalledTimes(1);
    // The replay never reaches the seat arm at all: the payment-status claim is
    // upstream of it and the claim is a CAS, so the second delivery sees a
    // SUCCEEDED row and stops.
    expect(participantUpdateMany).toHaveBeenCalledTimes(1);
  });

  it("a seat already CONFIRMED stays a no-op: no refund, no ops row", async () => {
    // The CAS misses because the row is already live, not because it is gone.
    participantUpdateMany.mockResolvedValue({ count: 0 });
    participantFindFirst.mockResolvedValue({
      id: "part-1",
      status: "CONFIRMED",
      paymentId: "pay-1",
    });

    const result = await confirmExistingAppointment(
      txStub as never,
      APPOINTMENT,
      BUYER,
    );

    expect(result).toEqual({ capturedAfterTerminal: false });
    expect(recordSystemErrorSafe).not.toHaveBeenCalled();
  });

  it("a seat with no row at all is refunded and reported distinctly", async () => {
    participantUpdateMany.mockResolvedValue({ count: 0 });
    participantFindFirst.mockResolvedValue(null);

    const result = await confirmExistingAppointment(
      txStub as never,
      APPOINTMENT,
      BUYER,
    );

    expect(result).toEqual({ capturedAfterTerminal: true, seatReleased: true });
    expect(recordSystemErrorSafe).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({
          reason: expect.stringContaining("no participant row exists"),
        }),
      }),
    );
  });

  it("the ops row is written once per seat, however often the branch is re-driven", async () => {
    participantUpdateMany.mockResolvedValue({ count: 0 });
    participantFindFirst.mockResolvedValue({
      id: "part-1",
      status: "REFUNDED",
      paymentId: "pay-1",
    });
    // The orphan re-drive sweep re-enters this branch on a seat already
    // refunded; only the first run may say so.
    systemEventFindFirst.mockResolvedValueOnce(null).mockResolvedValue({
      id: "ev-1",
    });

    await confirmExistingAppointment(txStub as never, APPOINTMENT, BUYER);
    await confirmExistingAppointment(txStub as never, APPOINTMENT, BUYER);

    expect(recordSystemErrorSafe).toHaveBeenCalledTimes(1);
  });

  it("a class seat under the same rule is reported the same way", async () => {
    appointmentFindUnique.mockResolvedValue({
      id: APPOINTMENT,
      consultation: null,
      subscription: null,
      webinar: null,
      class: { id: "class-1" },
    });
    participantUpdateMany.mockResolvedValue({ count: 0 });
    participantFindFirst.mockResolvedValue({
      id: "part-2",
      status: "CANCELLED",
      paymentId: "pay-1",
    });

    const result = await confirmExistingAppointment(
      txStub as never,
      APPOINTMENT,
      BUYER,
    );

    expect(result).toEqual({ capturedAfterTerminal: true, seatReleased: true });
  });
});

describe("the auto-refund marker on a released seat", () => {
  beforeEach(() => {
    participantUpdateMany.mockResolvedValue({ count: 0 });
    participantFindFirst.mockResolvedValue({
      id: "part-1",
      status: "CANCELLED",
      paymentId: "pay-1",
    });
    markerRow.mockResolvedValue({
      description:
        "Auto-refund pending: capture landed after the seat was released",
    });
    markerSettle.mockResolvedValue({ count: 1 });
  });
  afterEach(() => markerRow.mockResolvedValue(null));

  const deliver = () =>
    handlePaymentSuccess(
      "order-1",
      WEBINAR_METADATA as unknown as Record<string, string>,
      10000,
    );

  it("is settled once the refund succeeds", async () => {
    await deliver();
    expect(markerSettle).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "pay-1" }),
      }),
    );
  });

  it("survives a refund that throws, so retry-auto-refunds re-drives it", async () => {
    refundBookingPayment.mockRejectedValueOnce(new Error("gateway timeout"));
    await deliver();
    expect(refundBookingPayment).toHaveBeenCalledTimes(1);
    expect(markerSettle).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Part B — a legacy capture for a full event must not be seated past the room.
// ---------------------------------------------------------------------------
describe("a legacy capture for an event with no room left", () => {
  it("takes no seat, records why, and returns the money", async () => {
    paymentFindUnique.mockResolvedValue(
      pendingSeatPayment({ appointmentId: null }),
    );
    webinarFindUnique.mockResolvedValue(liveWebinarRow());
    getWebinarCapacity.mockReturnValue({
      max: 1,
      registered: 1,
      remaining: 0,
      isFull: true,
    });
    (validateWebhookMetadata as jest.Mock).mockReturnValue(WEBINAR_METADATA);

    const outcome = await handlePaymentSuccess(
      "order-1",
      WEBINAR_METADATA as unknown as Record<string, string>,
      10000,
    );

    expect(outcome).toBe("captured_after_release");
    // The oversell this replaces: a seat on a full webinar, kept money, no row.
    expect(participantCreateMany).not.toHaveBeenCalled();
    expect(recordSystemErrorSafe).toHaveBeenCalledWith(
      expect.objectContaining({
        db: txStub,
        err: expect.objectContaining({
          message: "CAPTURE_CANNOT_SEAT_FULL_EVENT",
        }),
      }),
    );
    // No seat exists, so the payment is addressed by id through the booking
    // door — and the marker makes the refund re-drivable.
    expect(refundBookingPayment).toHaveBeenCalledWith(
      expect.objectContaining({ paymentId: "pay-1" }),
    );
    expect(paymentUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          description: expect.stringContaining("Auto-refund pending:"),
        }),
      }),
    );
  });

  it("a full class refuses the same way, and the gate is the canonical one", async () => {
    paymentFindUnique.mockResolvedValue(
      pendingSeatPayment({ appointmentId: null }),
    );
    classFindUnique.mockResolvedValue(liveClassRow());
    getClassCapacity.mockReturnValue({
      max: 2,
      registered: 2,
      remaining: 0,
      isFull: true,
    });
    (validateWebhookMetadata as jest.Mock).mockReturnValue(CLASS_METADATA);

    const outcome = await handlePaymentSuccess(
      "order-1",
      CLASS_METADATA as unknown as Record<string, string>,
      10000,
    );

    expect(outcome).toBe("captured_after_release");
    expect(getClassCapacity).toHaveBeenCalledWith(
      expect.objectContaining({
        // The host does not consume a seat, and neither does the buyer whose
        // own seat is what the count is being read against.
        excludeUserIds: expect.arrayContaining(["host-1", BUYER]),
      }),
    );
    expect(participantCreateMany).not.toHaveBeenCalled();
    expect(refundBookingPayment).toHaveBeenCalledWith(
      expect.objectContaining({ paymentId: "pay-1" }),
    );
  });

  it("a buyer who already holds a live seat is not refused by their own room", async () => {
    paymentFindUnique.mockResolvedValue(
      pendingSeatPayment({ appointmentId: null }),
    );
    webinarFindUnique.mockResolvedValue(
      liveWebinarRow({
        appointment: {
          id: APPOINTMENT,
          occurrences: [{ id: "occ-1" }],
          participants: [{ userId: BUYER }],
        },
      }),
    );
    // One seat, one registrant — and that registrant is the payer, so the
    // room has no room for anyone else but is not full for them.
    getWebinarCapacity.mockReturnValue({
      max: 1,
      registered: 0,
      remaining: 1,
      isFull: false,
    });
    appointmentFindUnique.mockResolvedValue({
      ...liveWebinarAppointment(),
      occurrences: [{ id: "occ-1" }],
    });

    const outcome = await handlePaymentSuccess(
      "order-1",
      WEBINAR_METADATA as unknown as Record<string, string>,
      10000,
    );

    expect(outcome).toBe("confirmed");
    expect(participantCreateMany).toHaveBeenCalledTimes(1);
    expect(refundBookingPayment).not.toHaveBeenCalled();
  });
});
