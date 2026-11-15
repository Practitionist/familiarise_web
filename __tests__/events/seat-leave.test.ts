/**
 * @jest-environment node
 */

/**
 * #1780 D-3 — a seat leave is refused inside the host's refund window (the
 * transaction rolls back before the seat is released) and refunded in full
 * outside it; a session the host moved after the purchase waives the window
 * (decision 6); an organiser removal is untouched.
 */

const refundSeat = jest.fn(async () => ({
  amountRefundedPaise: 100_000,
  refundPct: 100,
  rail: "GATEWAY",
}));
// The notify-me hooks are pinned by their own suites; here they stage nothing.
jest.mock("@/lib/booking/event-waitlist", () => ({
  stageSeatOpenedNotices: jest.fn(async () => ({ pages: [], email: null })),
  finishSeatOpenedNotices: jest.fn(async () => undefined),
  markEventWaitlistBooked: jest.fn(async () => ({ count: 0 })),
  expireEventWaitlist: jest.fn(async () => ({ expired: 0, purged: 0 })),
  hasLapsedEventWaitlist: jest.fn(async () => false),
}));
const notifyFreeSeatRemoved = jest.fn(async (..._a: unknown[]) => undefined);
jest.mock("@/lib/booking/seat-removed-notice", () => ({
  notifyFreeSeatRemoved: (...a: unknown[]) => notifyFreeSeatRemoved(...a),
}));
jest.mock("../../lib/payments/operations/event-refunds", () => ({
  refundRemovedAttendeeSeat: (...a: unknown[]) => refundSeat(...(a as [])),
}));

const stampRefundOwed = jest.fn(async () => true);
const driveRefundOwed = jest.fn(async () => ({ kind: "settled" }));
jest.mock("../../lib/payments/operations/refund-owed", () => ({
  stampRefundOwed: (...a: unknown[]) => stampRefundOwed(...(a as [])),
  driveRefundOwed: (...a: unknown[]) => driveRefundOwed(...(a as [])),
}));

const generation = new Date("2026-09-01T00:02:00Z");
const persistSeatRevocationInTx = jest.fn(
  async (..._a: unknown[]): Promise<Date | null> => generation,
);
const revokeEndedSeatAccess = jest.fn(async (..._a: unknown[]) => undefined);
jest.mock("../../lib/stream/access-revocation", () => ({
  persistSeatRevocationInTx: (...a: unknown[]) =>
    persistSeatRevocationInTx(...a),
  revokeEndedSeatAccess: (...a: unknown[]) => revokeEndedSeatAccess(...a),
}));

const joinedAt = new Date("2026-09-01T00:00:00Z");
const slot = { startsAt: new Date(), movedAt: null as Date | null };
const release = jest.fn(async () => ({ count: 1 }));
jest.mock("../../lib/prisma", () => {
  const tx = {
    appointmentParticipant: {
      findFirst: jest.fn(async () => ({
        id: "part-1",
        appointmentId: "apt-1",
        createdAt: joinedAt,
        refundWindowHours: null,
      })),
      updateMany: (...a: unknown[]) => release(...(a as [])),
    },
    webinar: {
      findUnique: jest.fn(async () => ({
        webinarPlan: { refundWindowHours: 24 },
      })),
    },
    appointmentOccurrence: { findFirst: jest.fn(async () => slot) },
    payment: {
      findFirst: jest.fn(async () => ({
        id: "pay-1",
        amount: 100_000,
        originalAmount: 100_000,
        paymentIntent: "order_1",
        currency: "INR",
        createdAt: joinedAt,
        refunds: [],
        disputes: [],
        appointment: { cancellationPolicy: null },
      })),
    },
  };
  return {
    __esModule: true,
    default: {
      appointment: { findFirst: jest.fn(async () => ({ id: "apt-1" })) },
      $transaction: jest.fn(async (fn: (t: unknown) => unknown) => fn(tx)),
    },
  };
});

import { BookingRuleError } from "@/lib/booking/booking-rule-error";
import { isHostMove } from "@/lib/booking/class-series";
import { leaveEventSeat } from "@/lib/booking/seat-leave";
import {
  finishSeatOpenedNotices,
  stageSeatOpenedNotices,
} from "@/lib/booking/event-waitlist";

const leave = (isSelfLeave = true) =>
  leaveEventSeat({
    kind: "webinar",
    eventId: "web-1",
    userId: "u-1",
    actorUserId: isSelfLeave ? "u-1" : "u-host",
    isSelfLeave,
  });
const inHours = (h: number) => new Date(Date.now() + h * 3_600_000);

beforeEach(() => {
  jest.clearAllMocks();
  slot.movedAt = null;
});

it("refuses 20 h before a 24 h window and never releases the seat", async () => {
  slot.startsAt = inHours(20);
  await expect(leave()).rejects.toMatchObject({
    code: "REFUND_WINDOW_CLOSED",
  });
  await expect(leave()).rejects.toBeInstanceOf(BookingRuleError);
  expect(release).not.toHaveBeenCalled();
  expect(refundSeat).not.toHaveBeenCalled();
  expect(stageSeatOpenedNotices).not.toHaveBeenCalled();
});

it("releases and refunds in full 30 h before, keyed on the seat", async () => {
  slot.startsAt = inHours(30);
  await leave();
  expect(release).toHaveBeenCalledTimes(1);
  expect(refundSeat).toHaveBeenCalledWith(
    expect.objectContaining({ mode: "full", dedupeKey: "seat-leave:part-1" }),
  );
});

it("stages the seat-opened notice in the release commit and finishes it after", async () => {
  slot.startsAt = inHours(30);
  const staged = { pages: [], email: null };
  jest.mocked(stageSeatOpenedNotices).mockResolvedValueOnce(staged);
  await leave();
  expect(stageSeatOpenedNotices).toHaveBeenCalledWith(
    expect.anything(),
    expect.any(String),
    expect.any(Date),
  );
  expect(finishSeatOpenedNotices).toHaveBeenCalledWith(staged);
});

it("stamps the refund owed in the release commit, so a crash after it is re-driven", async () => {
  slot.startsAt = inHours(30);
  refundSeat.mockRejectedValueOnce(new Error("function died mid-refund"));
  await expect(leave()).rejects.toThrow("function died mid-refund");
  expect(release).toHaveBeenCalledTimes(1);
  expect(stampRefundOwed).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({
      paymentId: "pay-1",
      amountPaise: null,
      key: "seat-leave:part-1:pay:pay-1",
    }),
  );
  expect(driveRefundOwed).not.toHaveBeenCalled();
});

it("writes the seat revocation through the release transaction, so a stalled refund cannot lose it", async () => {
  slot.startsAt = inHours(30);
  refundSeat.mockRejectedValueOnce(new Error("refund stalled"));
  await expect(leave()).rejects.toThrow("refund stalled");
  expect(persistSeatRevocationInTx).toHaveBeenCalledWith(
    expect.objectContaining({ appointmentParticipant: expect.anything() }),
    "apt-1",
    ["u-1"],
  );
  const written = persistSeatRevocationInTx.mock.invocationCallOrder[0];
  expect(release.mock.invocationCallOrder[0]).toBeLessThan(written);
  expect(written).toBeLessThan(refundSeat.mock.invocationCallOrder[0]);
  expect(revokeEndedSeatAccess).not.toHaveBeenCalled();
});

it("drives nothing when the release transaction throws after the write", async () => {
  slot.startsAt = inHours(30);
  jest
    .mocked(stageSeatOpenedNotices)
    .mockRejectedValueOnce(new Error("staging failed"));
  await expect(leave()).rejects.toThrow("staging failed");
  expect(persistSeatRevocationInTx).toHaveBeenCalledTimes(1);
  expect(refundSeat).not.toHaveBeenCalled();
  expect(revokeEndedSeatAccess).not.toHaveBeenCalled();
});

it("drives the seat row the release committed, at its generation", async () => {
  slot.startsAt = inHours(30);
  await leave();
  expect(revokeEndedSeatAccess).toHaveBeenCalledWith(
    "apt-1",
    ["u-1"],
    generation,
  );
});

it("settles the marker after the refund under the same key", async () => {
  slot.startsAt = inHours(30);
  await leave();
  expect(refundSeat).toHaveBeenCalledWith(
    expect.objectContaining({ paymentId: "pay-1" }),
  );
  expect(driveRefundOwed).toHaveBeenCalledWith(
    expect.objectContaining({ key: "seat-leave:part-1:pay:pay-1" }),
    expect.anything(),
  );
});

it("waives the window for a session the host moved after the purchase", async () => {
  slot.startsAt = inHours(20);
  slot.movedAt = new Date();
  await leave();
  expect(refundSeat).toHaveBeenCalledWith(
    expect.objectContaining({ mode: "full" }),
  );
});

it("leaves an organiser removal untouched (full, organiser-initiated)", async () => {
  slot.startsAt = inHours(1);
  await leave(false);
  expect(refundSeat).toHaveBeenCalledWith(
    expect.objectContaining({ mode: "full", initiatedBy: "organiser" }),
  );
});

it("tells an attendee removed from a free seat, who gets no refund notice", async () => {
  slot.startsAt = inHours(1);
  await leave(false);
  expect(notifyFreeSeatRemoved).not.toHaveBeenCalled();
  const { default: db } = jest.requireMock("../../lib/prisma") as {
    default: {
      $transaction: (fn: (t: unknown) => unknown) => Promise<unknown>;
    };
  };
  const tx = (await db.$transaction((t) => t)) as {
    payment: { findFirst: jest.Mock };
  };
  tx.payment.findFirst.mockResolvedValueOnce({
    id: "pay-free",
    amount: 0,
    originalAmount: 0,
    paymentIntent: "free_1",
    currency: "INR",
    createdAt: joinedAt,
    refunds: [],
    disputes: [],
    appointment: { cancellationPolicy: null },
  });
  refundSeat.mockResolvedValueOnce({
    amountRefundedPaise: 0,
    refundPct: 100,
    rail: null as unknown as string,
  });
  await leave(false);
  await new Promise((resolve) => setImmediate(resolve));
  expect(notifyFreeSeatRemoved).toHaveBeenCalledWith(
    expect.objectContaining({ attendeeUserId: "u-1" }),
  );
});

it("a re-plan with unchanged times is not a move; a changed one is", () => {
  const prior = {
    ordinal: 3,
    startsAt: inHours(40),
    endsAt: inHours(41),
  };
  const moves = { isReschedule: false, freedWindows: [prior] };
  expect(isHostMove({ ...prior }, moves)).toBe(false);
  expect(isHostMove({ ...prior, startsAt: inHours(42) }, moves)).toBe(true);
});

it("refuses a class exit without the exit right (#1780 E-5)", async () => {
  const mocked = jest.requireMock("../../lib/prisma") as {
    default: { $transaction: jest.Mock };
  };
  mocked.default.$transaction.mockImplementationOnce(
    async (fn: (t: unknown) => unknown) =>
      fn({
        appointmentParticipant: {
          findFirst: async () => ({
            id: "part-1",
            appointmentId: "apt-1",
            createdAt: joinedAt,
            refundWindowHours: null,
          }),
          updateMany: release,
        },
        appointment: {
          findUnique: async () => ({
            class: { classPlan: { totalSessions: 12 } },
          }),
        },
        appointmentOccurrence: { findMany: async () => [] },
        // The leave reads the seat's payment once, before the rule runs.
        payment: { findFirst: async () => null },
      }),
  );
  await expect(
    leaveEventSeat({
      kind: "class",
      eventId: "cls-1",
      userId: "u-1",
      actorUserId: "u-1",
      isSelfLeave: true,
      exit: true,
    }),
  ).rejects.toMatchObject({ code: "EXIT_NOT_AVAILABLE" });
  expect(release).not.toHaveBeenCalled();
});
