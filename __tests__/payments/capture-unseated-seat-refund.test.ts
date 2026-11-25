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
// The notify-me hooks are pinned by their own suites; here they stage nothing.
jest.mock("@/lib/booking/event-waitlist", () => ({
  stageSeatOpenedNotices: jest.fn(async () => ({ pages: [], email: null })),
  finishSeatOpenedNotices: jest.fn(async () => undefined),
  markEventWaitlistBooked: jest.fn(async () => ({ count: 0 })),
  expireEventWaitlist: jest.fn(async () => ({ expired: 0, purged: 0 })),
  hasLapsedEventWaitlist: jest.fn(async () => false),
}));
jest.mock("@/lib/referrals/referral-notify", () => ({
  readCreditsApplied: jest.fn(async () => null),
  prepareCreditsAppliedEmail: jest.fn(),
  stageCreditsApplied: jest.fn(async () => ({})),
  stageReferralReward: jest.fn(async () => ({})),
}));
jest.mock("../../lib/db/serializable-retry", () => ({
  __esModule: true,
  withSerializableRetry: (fn: () => unknown) => withSerializableRetry(fn),
}));

const captureException = jest.fn();
jest.mock("@sentry/core", () => jest.requireMock("@sentry/nextjs"));
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
const occurrenceFindMany = jest.fn().mockResolvedValue([]);
const buyerConflictFindFirst = jest.fn().mockResolvedValue(null);

const txStub = {
  $executeRaw: jest.fn(async () => 0),
  payment: {
    findUnique: paymentFindUnique,
    update: paymentUpdate,
    updateMany: paymentUpdateMany,
  },
  appointment: {
    findUnique: appointmentFindUnique,
    findFirst: buyerConflictFindFirst,
    update: jest.fn(),
  },
  consultantProfile: { findUnique: jest.fn().mockResolvedValue(null) },
  appointmentParticipant: {
    createMany: participantCreateMany,
    updateMany: participantUpdateMany,
    // The capture's seat CAS returns the moved rows, for their SEAT history row.
    updateManyAndReturn: async (args: { select?: unknown }) => {
      const { select: _select, ...cas } = args;
      const res = (await participantUpdateMany(cas)) as { count?: number };
      return Array.from({ length: res?.count ?? 0 }, (_v, i) => ({
        id: `part-${i}`,
        appointmentId: "appt",
        userId: "user",
        role: "CONSULTEE",
      }));
    },
    findMany: jest.fn().mockResolvedValue([]),
    findFirst: participantFindFirst,
  },
  appointmentOccurrence: {
    findMany: occurrenceFindMany,
    findFirst: jest.fn().mockResolvedValue(null),
    updateMany: jest.fn().mockResolvedValue({ count: 0 }),
  },
  systemEvent: { findFirst: systemEventFindFirst },
  webinar: { findUnique: webinarFindUnique, updateMany: webinarUpdateMany },
  class: { findUnique: classFindUnique, updateMany: classUpdateMany },
  bookingStatusHistory: { createMany: jest.fn(), create: historyCreate },
  paymentLeg: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
};

const fetchRazorpayOrder = jest.fn();
jest.mock("../../lib/payments/core/razorpay", () => ({
  __esModule: true,
  fetchRazorpayOrder: (...a: unknown[]) => fetchRazorpayOrder(...a),
}));

jest.mock("../../lib/payments/ledger/unapplied-receipts", () => ({
  postUnappliedReceipt: jest.fn(),
}));
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
  stageRenderFailure: jest.fn(),
  prepareAppointmentBookedEmail: jest.fn(),
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
  handlePaymentFailure,
  handlePaymentSuccess,
  refundLateCapture,
} from "../../lib/payments/webhooks/handlers";
import prisma from "../../lib/prisma";
import { validateWebhookMetadata } from "../../schemas/webhooks/metadata";

const markerRow = prisma.payment.findUnique as unknown as jest.Mock;
const markerSettle = prisma.payment.updateMany as unknown as jest.Mock;
const markerOverwrite = prisma.payment.update as unknown as jest.Mock;

const BUYER = "user-1";
const WEBINAR = "web-1";
const APPOINTMENT = "appt-web-1";

const HOUR_MS = 3_600_000;
/** One session row of the event, `startsInHours` from now and an hour long. */
function session(startsInHours: number, ordinal = 1) {
  const startsAt = new Date(Date.now() + startsInHours * HOUR_MS);
  return {
    ordinal,
    startsAt,
    endsAt: new Date(startsAt.getTime() + HOUR_MS),
    completionStatus: "SCHEDULED",
  };
}

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
    classPlan: { price: 10000, totalSessions: 2, lateJoinUntilSession: null },
  });
  // An event still on sale: its sessions are ahead and the buyer is free.
  occurrenceFindMany.mockResolvedValue([session(24, 1), session(48, 2)]);
  buyerConflictFindFirst.mockResolvedValue(null);
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

// A HELD seat is promoted only while checkout would still sell it to this buyer.
describe("a capture that lands when checkout would no longer sell the seat", () => {
  const classAppointment = {
    id: APPOINTMENT,
    consultation: null,
    subscription: null,
    webinar: null,
    class: { id: "class-1" },
  };
  const released = { capturedAfterTerminal: true, seatReleased: true };
  const cancelledHeldSeat = expect.objectContaining({
    where: expect.objectContaining({
      AND: expect.arrayContaining([
        expect.objectContaining({ userId: BUYER, status: "HELD" }),
      ]),
    }),
    data: { status: "CANCELLED" },
  });
  const promoted = expect.objectContaining({ data: { status: "CONFIRMED" } });
  const confirm = () =>
    confirmExistingAppointment(txStub as never, APPOINTMENT, BUYER);

  // The re-read after the release finds the seat this capture just cancelled.
  beforeEach(() =>
    participantFindFirst.mockResolvedValue({
      id: "part-1",
      status: "CANCELLED",
      paymentId: "pay-1",
    }),
  );

  it("a webinar whose session has ended releases the HELD seat and refunds in full", async () => {
    occurrenceFindMany.mockResolvedValue([session(-3)]);

    const outcome = await handlePaymentSuccess(
      "order-1",
      WEBINAR_METADATA as unknown as Record<string, string>,
      10000,
    );

    expect(outcome).toBe("confirmed");
    expect(participantUpdateMany).toHaveBeenCalledWith(cancelledHeldSeat);
    expect(participantUpdateMany).not.toHaveBeenCalledWith(promoted);
    // No amount named: the booking door refunds the whole refundable balance.
    expect(refundBookingPayment).toHaveBeenCalledWith({
      paymentId: "pay-1",
      reason: "capture after seat release",
      initiatedByUserId: null,
      dedupeKey: "capture-unseated:pay-1",
    });
    expect(recordSystemErrorSafe).toHaveBeenCalledWith(
      expect.objectContaining({
        db: txStub,
        context: expect.objectContaining({
          reason: expect.stringContaining("has ended"),
        }),
      }),
    );
  });

  it("a COMPLETED webinar is not sold, whatever its session row says", async () => {
    webinarFindUnique.mockResolvedValue({ status: "COMPLETED" });
    expect(await confirm()).toEqual(released);
    expect(participantUpdateMany).not.toHaveBeenCalledWith(promoted);
  });

  it("a class past its enrolment cutoff is not sold", async () => {
    appointmentFindUnique.mockResolvedValue(classAppointment);
    // Session 1 has started and the host allows no late join.
    occurrenceFindMany.mockResolvedValue([session(-0.5, 1), session(24, 2)]);
    expect(await confirm()).toEqual(released);
    expect(participantUpdateMany).toHaveBeenCalledWith(cancelledHeldSeat);
  });

  it("a class still open to a late join confirms the seat", async () => {
    appointmentFindUnique.mockResolvedValue(classAppointment);
    classFindUnique.mockResolvedValue({
      status: "SCHEDULED",
      classPlan: { price: 10000, totalSessions: 2, lateJoinUntilSession: 2 },
    });
    occurrenceFindMany.mockResolvedValue([session(-0.5, 1), session(24, 2)]);
    expect(await confirm()).toEqual({ capturedAfterTerminal: false });
    expect(participantUpdateMany).toHaveBeenCalledWith(promoted);
  });

  it("a buyer with another live booking at that time is refunded, not double-booked", async () => {
    buyerConflictFindFirst.mockResolvedValue({ id: "appt-other" });
    expect(await confirm()).toEqual(released);
    expect(participantUpdateMany).toHaveBeenCalledWith(cancelledHeldSeat);
    // The buyer's own seat on this event is not a conflict with itself.
    expect(buyerConflictFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          AND: expect.arrayContaining([{ NOT: { id: { in: [APPOINTMENT] } } }]),
        }),
      }),
    );
  });

  it("a redelivery for a seat already CONFIRMED on an ended event stays a no-op", async () => {
    occurrenceFindMany.mockResolvedValue([session(-3)]);
    participantUpdateMany.mockResolvedValue({ count: 0 });
    participantFindFirst.mockResolvedValue({
      id: "part-1",
      status: "CONFIRMED",
      paymentId: "pay-1",
    });
    expect(await confirm()).toEqual({ capturedAfterTerminal: false });
    expect(recordSystemErrorSafe).not.toHaveBeenCalled();
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

// A hold still live when the gateway took the money is honoured: only an ended event or a busy buyer refunds.
describe("a capture the gateway took while the seat's hold was live", () => {
  const MIN_MS = 60_000;
  const classAppointment = {
    id: APPOINTMENT,
    consultation: null,
    subscription: null,
    webinar: null,
    class: { id: "class-1" },
  };
  const released = { capturedAfterTerminal: true, seatReleased: true };
  const promoted = expect.objectContaining({ data: { status: "CONFIRMED" } });
  const cancelled = expect.objectContaining({ data: { status: "CANCELLED" } });
  /** Paid at 09:58, session 1 started at 10:00 with no late join, processed at 10:01; the hold runs to 10:10. */
  const paidBeforeTheStart = () => {
    appointmentFindUnique.mockResolvedValue(classAppointment);
    occurrenceFindMany.mockResolvedValue([session(-1 / 60, 1), session(24, 2)]);
    paymentFindUnique.mockResolvedValue(
      pendingSeatPayment({ expiresAt: new Date(Date.now() + 9 * MIN_MS) }),
    );
    participantFindFirst.mockResolvedValue({
      id: "part-1",
      status: "CANCELLED",
      paymentId: "pay-1",
    });
    return new Date(Date.now() - 3 * MIN_MS);
  };
  const capture = (gatewayCapturedAt?: Date) =>
    handlePaymentSuccess(
      "order-1",
      CLASS_METADATA as unknown as Record<string, string>,
      10000,
      "pay_gw_1",
      gatewayCapturedAt ? { gatewayCapturedAt } : undefined,
    );

  it("seats a buyer who paid at 09:58 for a class that started at 10:00, processed at 10:01", async () => {
    const paidAt = paidBeforeTheStart();

    expect(await capture(paidAt)).toBe("confirmed");

    expect(participantUpdateMany).toHaveBeenCalledWith(promoted);
    expect(participantUpdateMany).not.toHaveBeenCalledWith(cancelled);
    expect(refundBookingPayment).not.toHaveBeenCalled();
  });

  it("with no gateway time the processing time decides: enrolment has closed, so it refunds", async () => {
    paidBeforeTheStart();

    await capture();

    expect(participantUpdateMany).toHaveBeenCalledWith(cancelled);
    expect(participantUpdateMany).not.toHaveBeenCalledWith(promoted);
    expect(refundBookingPayment).toHaveBeenCalledTimes(1);
  });

  it("a gateway time later than the hold deadline is not inside the hold", async () => {
    paidBeforeTheStart();

    await capture(new Date(Date.now() + 10 * MIN_MS));

    expect(participantUpdateMany).not.toHaveBeenCalledWith(promoted);
    expect(refundBookingPayment).toHaveBeenCalledTimes(1);
  });

  const confirmPaidInsideHold = () =>
    confirmExistingAppointment(txStub as never, APPOINTMENT, BUYER, {
      paidInsideHold: true,
    });

  it("still refunds in full when the class has ended", async () => {
    paidBeforeTheStart();
    occurrenceFindMany.mockResolvedValue([session(-48, 1), session(-24, 2)]);

    expect(await confirmPaidInsideHold()).toEqual(released);
    expect(participantUpdateMany).not.toHaveBeenCalledWith(promoted);
  });

  it("still refunds in full when a webinar is over", async () => {
    occurrenceFindMany.mockResolvedValue([session(-3)]);
    participantFindFirst.mockResolvedValue({
      id: "part-1",
      status: "CANCELLED",
      paymentId: "pay-1",
    });

    expect(await confirmPaidInsideHold()).toEqual(released);
  });

  it("still refunds in full when the buyer has another live booking at that time", async () => {
    paidBeforeTheStart();
    buyerConflictFindFirst.mockResolvedValue({ id: "appt-other" });

    expect(await confirmPaidInsideHold()).toEqual(released);
    expect(participantUpdateMany).not.toHaveBeenCalledWith(promoted);
  });
});

// The post-commit marker writers replace only the pending marker they read.
describe("a post-commit marker writer", () => {
  const STUCK =
    "Auto-refund stuck: capture amount 9000p ≠ expected 10000p. Booking NOT confirmed.";
  const PENDING =
    "Auto-refund pending: capture landed on a EXPIRED payment whose hold was already released. Booking NOT confirmed.";
  afterEach(() => markerRow.mockResolvedValue(null));

  it("the late-capture refund leaves a stuck marker as the retry sweep wrote it", async () => {
    markerRow.mockResolvedValue({ description: STUCK });

    await refundLateCapture({
      paymentId: "pay-1",
      releasedBy: "payment EXPIRED",
    });

    expect(markerOverwrite).not.toHaveBeenCalled();
    expect(markerSettle).not.toHaveBeenCalled();
  });

  it("the late-capture refund replaces a pending marker by compare-and-set on it", async () => {
    markerRow.mockResolvedValue({ description: PENDING });

    await refundLateCapture({
      paymentId: "pay-1",
      releasedBy: "payment EXPIRED",
    });

    expect(markerOverwrite).not.toHaveBeenCalled();
    expect(markerSettle).toHaveBeenCalledWith({
      where: { id: "pay-1", description: PENDING },
      data: {
        description: expect.stringMatching(
          /^Auto-refunded: capture landed after the hold was released \(payment EXPIRED\)/,
        ),
      },
    });
  });

  it("the amount-mismatch refund leaves a stuck marker as the retry sweep wrote it", async () => {
    markerRow.mockResolvedValue({ description: STUCK });

    const outcome = await handlePaymentSuccess(
      "order-1",
      WEBINAR_METADATA as unknown as Record<string, string>,
      9000,
    );

    expect(outcome).toBe("amount_mismatch");
    expect(refundPayment).toHaveBeenCalledTimes(1);
    expect(markerOverwrite).not.toHaveBeenCalled();
    expect(markerSettle).not.toHaveBeenCalled();
  });
});

// A failed attempt inside the hold window changes nothing on the row.
describe("a failed attempt while the hold is still open", () => {
  it("does not store the failed attempt's gateway payment id on the PENDING row", async () => {
    paymentFindUnique.mockResolvedValue(
      pendingSeatPayment({
        gatewayPaymentId: null,
        expiresAt: new Date(Date.now() + 10 * 60_000),
        appointment: null,
      }),
    );

    await handlePaymentFailure("order-1", "card declined", "pay_failed_1");

    expect(paymentUpdateMany).not.toHaveBeenCalled();
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

// A seat re-buy re-mints the row in place and leaves its old order on an EXPIRED tombstone.
describe("a late capture on a re-mint tombstone", () => {
  it("claims the appointment-less EXPIRED row and refunds it, seating nobody", async () => {
    paymentFindUnique.mockResolvedValue(
      pendingSeatPayment({
        id: "pay-tombstone",
        paymentIntent: "order-old",
        paymentStatus: "EXPIRED",
        appointmentId: null,
      }),
    );

    const outcome = await handlePaymentSuccess(
      "order-old",
      WEBINAR_METADATA,
      10000,
    );

    expect(outcome).toBe("captured_after_release");
    expect(paymentUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "pay-tombstone", paymentStatus: "EXPIRED" },
        data: expect.objectContaining({ paymentStatus: "SUCCEEDED" }),
      }),
    );
    expect(participantCreateMany).not.toHaveBeenCalled();
    expect(refundBookingPayment).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentId: "pay-tombstone",
        amountPaise: 10000,
      }),
    );
  });
});

// Adoption trusts only the order Razorpay holds: its notes name the row, its amount and currency must match.
describe("a capture whose order was never written onto its row", () => {
  const ORDER = "order_unrecorded";
  const PRE_MINT = "premint_abc";
  const GENUINE = { id: ORDER, amount: 10000, currency: "INR", status: "paid" };
  type FindArgs = { where: { id?: string; paymentIntent?: string } };

  /** The row by id carries `intentById`; by order id it appears only once adopted. */
  function rows(intentById: string) {
    let adopted = false;
    paymentUpdateMany.mockImplementation(
      async (args: { data: { paymentIntent?: string } }) => {
        if (args.data.paymentIntent === ORDER) adopted = true;
        return { count: 1 };
      },
    );
    paymentFindUnique.mockImplementation(async ({ where }: FindArgs) => {
      if (where.id)
        return { paymentIntent: intentById, amount: 10000, currency: "INR" };
      return adopted
        ? pendingSeatPayment({ id: "pay-premint", paymentIntent: ORDER })
        : null;
    });
  }
  const adoptWrite = expect.objectContaining({
    data: { paymentIntent: ORDER },
  });

  it("adopts the row the fetched order names by CAS, then confirms it", async () => {
    rows(PRE_MINT);
    fetchRazorpayOrder.mockResolvedValue({
      ...GENUINE,
      notes: { familiarisePaymentId: "pay-premint" },
    });

    const outcome = await handlePaymentSuccess(ORDER, WEBINAR_METADATA, 10000);

    expect(outcome).toBe("confirmed");
    expect(fetchRazorpayOrder).toHaveBeenCalledWith(ORDER);
    expect(paymentUpdateMany).toHaveBeenCalledWith({
      where: { id: "pay-premint", paymentIntent: PRE_MINT, amount: 10000 },
      data: { paymentIntent: ORDER },
    });
  });

  it("ignores client-forged payment notes naming another user's pre-mint row", async () => {
    rows(PRE_MINT);
    fetchRazorpayOrder.mockResolvedValue({ ...GENUINE, notes: {} });
    const forged = { ...WEBINAR_METADATA, familiarisePaymentId: "pay-premint" };

    await expect(handlePaymentSuccess(ORDER, forged, 10000)).rejects.toThrow(
      "Payment record not found",
    );
    expect(paymentUpdateMany).not.toHaveBeenCalledWith(adoptWrite);
  });

  it("never adopts when the order amount differs from the row", async () => {
    rows(PRE_MINT);
    fetchRazorpayOrder.mockResolvedValue({
      ...GENUINE,
      amount: 100,
      notes: { familiarisePaymentId: "pay-premint" },
    });

    await expect(
      handlePaymentSuccess(ORDER, WEBINAR_METADATA, 100),
    ).rejects.toThrow("Payment record not found");
    expect(paymentUpdateMany).not.toHaveBeenCalledWith(adoptWrite);
  });

  it("never adopts when the order currency differs from the row", async () => {
    rows(PRE_MINT);
    fetchRazorpayOrder.mockResolvedValue({
      ...GENUINE,
      currency: "USD",
      notes: { familiarisePaymentId: "pay-premint" },
    });

    await expect(
      handlePaymentSuccess(ORDER, WEBINAR_METADATA, 10000),
    ).rejects.toThrow("Payment record not found");
    expect(paymentUpdateMany).not.toHaveBeenCalledWith(adoptWrite);
  });

  it("does not confirm when the adoption CAS loses the race", async () => {
    rows(PRE_MINT);
    paymentUpdateMany.mockResolvedValue({ count: 0 });
    fetchRazorpayOrder.mockResolvedValue({
      ...GENUINE,
      notes: { familiarisePaymentId: "pay-premint" },
    });

    await expect(
      handlePaymentSuccess(ORDER, WEBINAR_METADATA, 10000),
    ).rejects.toThrow("Payment record not found");
  });

  it("never hijacks a row whose intent is a real order", async () => {
    rows("order_someone_else");
    fetchRazorpayOrder.mockResolvedValue({
      ...GENUINE,
      notes: { familiarisePaymentId: "pay-premint" },
    });

    await expect(
      handlePaymentSuccess(ORDER, WEBINAR_METADATA, 10000),
    ).rejects.toThrow("Payment record not found");
    expect(paymentUpdateMany).not.toHaveBeenCalledWith(adoptWrite);
  });

  it("throws before the transaction when the order cannot be fetched, so the capture is retried", async () => {
    rows(PRE_MINT);
    fetchRazorpayOrder.mockRejectedValue(new Error("gateway timeout"));

    await expect(
      handlePaymentSuccess(ORDER, WEBINAR_METADATA, 10000),
    ).rejects.toThrow("gateway timeout");
    expect(paymentFindUnique).not.toHaveBeenCalled();
  });
});
