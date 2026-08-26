/**
 * @jest-environment node
 */

/**
 * HOIf / #1202 — LEGACY-shape capture (no appointmentId in metadata) must
 * birth its slots TENTATIVE, so the B2 event-state guard decides what
 * happens next:
 *
 *   - CANCELLED/DRAFT event → guard refuses, nothing is ever confirmed; the
 *     committed ghosts are tentative (swept by #830) and Phase 2 refunds.
 *     Before this fix the legacy creators wrote CONFIRMED rows that committed
     * even when the guard refused — refunded money + live slots on a dead
 *     calendar.
 *   - Live event → the ordinary confirm machinery flips the payer's rows,
 *     exactly like the NEW flow.
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

// Phase-1 tx stub — every model the legacy CLASS flow touches.
const slotCreate = jest.fn();
const slotUpdateMany = jest.fn().mockResolvedValue({ count: 0 });
const appointmentCreate = jest.fn();
let appointmentFindUniqueResult: unknown = null;
const appointmentFindUnique = jest.fn(() =>
  Promise.resolve(appointmentFindUniqueResult),
);
const classFindUnique = jest.fn();
const classUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
const paymentFindUnique = jest.fn();
const paymentUpdate = jest.fn().mockResolvedValue({});
const txStub = {
  payment: { findUnique: paymentFindUnique, update: paymentUpdate },
  slotOfAppointment: { create: slotCreate, updateMany: slotUpdateMany },
  appointment: { create: appointmentCreate, findUnique: appointmentFindUnique },
  class: { findUnique: classFindUnique, updateMany: classUpdateMany },
};

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    $transaction: async (fn: (tx: unknown) => unknown) => fn(txStub),
    payment: { update: jest.fn().mockResolvedValue({}) },
    appointment: { findUnique: jest.fn().mockResolvedValue(null) },
    // B4 pre-check reads these on the BASE client before the mutex.
    class: {
      findUnique: jest.fn().mockResolvedValue(null),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    webinar: {
      findUnique: jest.fn().mockResolvedValue(null),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  },
}));

const refundPayment = jest.fn().mockResolvedValue({ id: "rfnd" });
jest.mock("../../lib/payments/operations/refund", () => ({
  __esModule: true,
  refundPayment: (...a: unknown[]) => refundPayment(...a),
}));
jest.mock("../../lib/payments/payouts", () => ({
  __esModule: true,
  createEarningsFromPayment: jest.fn(),
}));
jest.mock("../../lib/email", () => ({
  __esModule: true,
  sendPaymentSuccessEmail: jest.fn(),
  sendPaymentFailedEmail: jest.fn(),
}));
jest.mock("../../lib/novu", () => ({
  __esModule: true,
  notifyPaymentSuccess: jest.fn(),
  notifyPaymentFailed: jest.fn(),
  notifyAppointmentBooked: jest.fn(),
}));
jest.mock("../../lib/referrals/service", () => ({
  __esModule: true,
  processQualifyingAction: jest.fn(),
  processConsultantBookingReferral: jest.fn(),
}));
jest.mock("../../actions/stream/chat/event-channel.action", () => ({
  __esModule: true,
  addUserToEventChannel: jest.fn(),
}));
jest.mock("../../actions/stream/chat/channel.action", () => ({
  __esModule: true,
  createDirectMessageChannel: jest.fn(),
}));
jest.mock("../../lib/stream-logger", () => ({
  __esModule: true,
  streamLogger: { info: jest.fn(), error: jest.fn() },
}));
jest.mock("../../lib/enterprise/system-events", () => ({
  __esModule: true,
  // Returns a promise — callers .catch() it.
  recordSystemError: () => Promise.resolve(),
}));
jest.mock("../../schemas/webhooks/metadata", () => ({
  __esModule: true,
  normalizeLegacySlotKeys: (m: unknown) => m,
  validateWebhookMetadata: jest.fn(),
}));
jest.mock("../../lib/events/capacity", () => ({
  __esModule: true,
  getWebinarCapacity: jest.fn(),
  getClassCapacity: jest.fn(),
}));

import { handlePaymentSuccess } from "../../lib/payments/webhooks/handlers";
import { validateWebhookMetadata } from "../../schemas/webhooks/metadata";

const VALID_METADATA = {
  appointmentType: "CLASS",
  userId: "user-1",
  planId: "plan-1",
  eventId: "class-1",
};

function makeCancelledClass() {
  return {
    id: "class-1",
    status: "CANCELLED",
    schedulingPeriodStartsAt: new Date("2026-01-01"),
    schedulingPeriodEndsAt: new Date("2026-03-01"),
    classPlan: {
      id: "plan-1",
      consultantProfile: { userId: "consultant-1" },
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  slotUpdateMany.mockResolvedValue({ count: 0 });
  classUpdateMany.mockResolvedValue({ count: 1 });
  paymentFindUnique.mockResolvedValue({
    id: "pay1",
    paymentIntent: "order1",
    amount: 10000,
    paymentStatus: "PENDING",
    userId: "user-1",
    currency: "INR",
    appointmentId: null, // LEGACY shape
    user: { email: "b@x.com", name: "Buyer", consulteeProfile: {} },
  });
  (validateWebhookMetadata as jest.Mock).mockReturnValue(VALID_METADATA);
});

describe("HOIf/#1202 — legacy capture births tentative slots, guard decides", () => {
  it("births the payer's slot TENTATIVE (never confirmed at creation)", async () => {
    const cancelled = makeCancelledClass();
    classFindUnique.mockResolvedValue(cancelled);
    classUpdateMany.mockResolvedValue({ count: 0 }); // CAS refuses CANCELLED
    appointmentCreate.mockResolvedValue({ id: "new-appt" });
    appointmentFindUniqueResult = {
      id: "new-appt",
      class: { id: "class-1", status: "CANCELLED" },
      consultation: null,
      subscription: null,
      webinar: null,
      slotsOfAppointment: [],
    };

    await handlePaymentSuccess(
      "order1",
      VALID_METADATA as unknown as Record<string, string>,
      10000,
    );

    // createClass births the slot NESTED inside appointment.create.
    expect(appointmentCreate).toHaveBeenCalledTimes(1);
    const created = appointmentCreate.mock.calls[0][0].data;
    expect(created.slotsOfAppointment.create.isTentative).toBe(true);
    expect(slotCreate).not.toHaveBeenCalled();
  });

  it("refuses a CANCELLED class: no confirmed flip, refund instead", async () => {
    classFindUnique.mockResolvedValue(makeCancelledClass());
    classUpdateMany.mockResolvedValue({ count: 0 }); // CAS misses → terminal

    await handlePaymentSuccess(
      "order1",
      VALID_METADATA as unknown as Record<string, string>,
      10000,
    );

    // No confirmed flip anywhere.
    expect(slotUpdateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: { isTentative: false } }),
    );
    // Phase 2 refunded the dead-booking capture.
    expect(refundPayment).toHaveBeenCalledWith(
      expect.objectContaining({ paymentId: "pay1", initiatedByUserId: null }),
    );
  });

  it("confirms the payer's rows when the class is LIVE", async () => {
    classFindUnique.mockResolvedValue(makeCancelledClass());
    // Overwrite status to SCHEDULED for the fresh read after a successful CAS.
    classFindUnique.mockImplementation(async (args: unknown) => {
      const where = (args ?? {}) as { id?: string };
      return {
        ...makeCancelledClass(),
        status: "SCHEDULED",
        id: where.id ?? "class-1",
      };
    });
    classUpdateMany.mockResolvedValue({ count: 1 }); // CAS succeeds
    appointmentCreate.mockResolvedValue({ id: "new-appt" });
    appointmentFindUniqueResult = {
      id: "new-appt",
      class: { id: "class-1", status: "SCHEDULED" },
      consultation: null,
      subscription: null,
      webinar: null,
      slotsOfAppointment: [],
    };

    await handlePaymentSuccess(
      "order1",
      VALID_METADATA as unknown as Record<string, string>,
      10000,
    );

    // The confirm machinery flipped the payer's class rows.
    expect(slotUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { isTentative: false } }),
    );
    expect(refundPayment).not.toHaveBeenCalled();
  });
});
