/**
 * @jest-environment node
 */

/**
 * #1554 — a class's "fully scheduled" gate and its engagement meter count
 * PLANNED sessions: a RESCHEDULED row is a session awaiting its new time, not
 * a missing one. Excluding it blocked every enrollment for the length of an
 * open reschedule and under-counted the engagements the seat buys.
 *
 * Mocks mirror consultation-occurrence-parity.test.ts: everything checkout.ts
 * touches at module scope is stubbed so the one exported handler can run
 * against a hand-built transaction.
 */

jest.mock("../../lib/db/serializable-retry", () => ({
  __esModule: true,
  withSerializableRetry: (fn: () => unknown) => fn(),
}));
jest.mock("@sentry/nextjs", () => ({
  __esModule: true,
  captureException: jest.fn(),
  captureMessage: jest.fn(),
  startSpan: (_o: unknown, fn: () => unknown) => fn(),
}));
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {},
}));
jest.mock("../../lib/payments/operations/refund", () => ({
  __esModule: true,
  refundPayment: jest.fn(),
}));
jest.mock("../../lib/payments/payouts", () => ({
  __esModule: true,
  createEarningsFromPayment: jest.fn(),
  reverseEarningsForPayment: jest.fn(),
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
  recordSystemError: () => Promise.resolve(),
}));
jest.mock("../../lib/compliance/dpdp", () => ({
  __esModule: true,
  checkConsent: jest.fn().mockResolvedValue(true),
}));
jest.mock("../../lib/payments/utils/slot-validation", () => ({
  __esModule: true,
  validateSlotTiming: jest.fn().mockReturnValue(null),
}));
jest.mock("../../lib/events/capacity", () => ({
  __esModule: true,
  getWebinarCapacity: jest.fn(),
  getClassCapacity: jest.fn().mockReturnValue({ isFull: false }),
}));

import { handleClassCheckout } from "../../lib/payments/operations/checkout";
import type { Tx } from "../../lib/prisma";
import type { CheckoutInput } from "../../schemas/checkout";

const HOUR = 60 * 60 * 1000;
const future = (days: number) => new Date(Date.now() + days * 24 * HOUR);

function occurrence(
  id: string,
  startsAt: Date,
  completionStatus = "SCHEDULED",
) {
  return {
    id,
    startsAt,
    endsAt: new Date(startsAt.getTime() + HOUR),
    isTentative: completionStatus === "RESCHEDULED",
    completionStatus,
    deletedAt: null,
  };
}

/** A four-session class where session 2 has been released for rescheduling. */
function txWith(occurrences: ReturnType<typeof occurrence>[]) {
  const createMany = jest.fn().mockResolvedValue({ count: 1 });
  const tx = {
    class: {
      findUnique: jest.fn().mockResolvedValue({
        id: "class-1",
        classPlan: {
          price: 100_000,
          totalSessions: 4,
          consultantProfile: { userId: "consultant-user" },
        },
        appointment: { id: "appt-class", occurrences, participants: [] },
      }),
    },
    appointmentParticipant: {
      createMany,
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      findMany: jest.fn().mockResolvedValue([]),
    },
  };
  return tx as unknown as Tx;
}

const PLANNED = [
  occurrence("s1", future(7)),
  occurrence("s2", future(14), "RESCHEDULED"),
  occurrence("s3", future(21)),
  occurrence("s4", future(28)),
];

it("counts a RESCHEDULED session as planned: the gate opens and the meter says four", async () => {
  const tx = txWith(PLANNED);
  const result = await handleClassCheckout(
    tx,
    { eventId: "class-1" } as unknown as CheckoutInput,
    "buyer-1",
    false,
  );

  expect(result.engagementsConsumed).toBe(4);
  expect(result.slotsLinked).toBe(4);
  // And the read itself keeps the released row: only a cancelled or deleted
  // session is out of the plan.
  const args = (tx.class.findUnique as jest.Mock).mock.calls[0][0];
  expect(args.include.appointment.include.occurrences.where).toEqual({
    deletedAt: null,
    completionStatus: { not: "CANCELLED" },
  });
});

it("still refuses a class that is genuinely short of sessions", async () => {
  await expect(
    handleClassCheckout(
      txWith(PLANNED.slice(0, 3)),
      { eventId: "class-1" } as unknown as CheckoutInput,
      "buyer-1",
      false,
    ),
  ).rejects.toThrow(/not fully scheduled yet \(3 of 4 sessions\)/);
});
