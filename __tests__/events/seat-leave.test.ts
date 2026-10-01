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
jest.mock("../../lib/payments/operations/event-refunds", () => ({
  refundRemovedAttendeeSeat: (...a: unknown[]) => refundSeat(...(a as [])),
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
  };
  return {
    __esModule: true,
    default: {
      $transaction: jest.fn(async (fn: (t: unknown) => unknown) => fn(tx)),
    },
  };
});

import { BookingRuleError } from "@/lib/booking/booking-rule-error";
import { isHostMove } from "@/lib/booking/class-series";
import { leaveEventSeat } from "@/lib/booking/seat-leave";

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
});

it("releases and refunds in full 30 h before, keyed on the seat", async () => {
  slot.startsAt = inHours(30);
  await leave();
  expect(release).toHaveBeenCalledTimes(1);
  expect(refundSeat).toHaveBeenCalledWith(
    expect.objectContaining({ mode: "full", dedupeKey: "seat-leave:part-1" }),
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
