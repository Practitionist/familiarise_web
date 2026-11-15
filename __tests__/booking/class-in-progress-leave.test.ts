/**
 * @jest-environment node
 */

/**
 * A class session under way is delivered when the attendee leaves (they chose
 * to go after it started) and refundable when the host cancels the series.
 */
jest.mock("@/lib/prisma", () => ({ __esModule: true, default: {} }));

import type { Tx } from "@/lib/prisma";
import {
  seatLedgerFrom,
  seriesCancelRefundPaise,
  type LedgerOccurrence,
} from "@/lib/booking/class-series";
import { planSelfLeave } from "@/lib/booking/seat-leave";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = new Date("2026-11-02T10:00:00.000Z");
const JOINED = new Date(NOW.getTime() - 30 * DAY);
const SEAT_PAISE = 800_000;

/** Eight weekly hour-long sessions; `firstStartMs` is session 1's offset from now. */
function weekly(firstStartMs: number): LedgerOccurrence[] {
  return Array.from({ length: 8 }, (_, i) => {
    const startsAt = new Date(NOW.getTime() + firstStartMs + i * 7 * DAY);
    return {
      ordinal: i + 1,
      startsAt,
      endsAt: new Date(startsAt.getTime() + HOUR),
      completionStatus:
        startsAt.getTime() + HOUR <= NOW.getTime() ? "COMPLETED" : "SCHEDULED",
      movedAt: null,
    };
  });
}

function fakeTx(occurrences: LedgerOccurrence[], retimeBy: Date | null = null) {
  return {
    class: {
      findUnique: jest.fn(async () => ({
        classPlan: { refundWindowHours: 24 },
        retimeBy,
        appointment: { id: "appt-class" },
      })),
    },
    appointment: {
      findUnique: jest.fn(async () => ({
        class: { classPlan: { totalSessions: 8 } },
      })),
    },
    appointmentOccurrence: {
      findMany: jest.fn(async () => occurrences),
      count: jest.fn(async () => 0),
    },
    refund: { findMany: jest.fn(async () => []) },
  } as unknown as Tx;
}

/** The seat's order as `seatPayment` selects it, read once by the leave. */
const payment = {
  id: "pay-seat",
  amount: SEAT_PAISE,
  originalAmount: SEAT_PAISE,
  paymentIntent: "order_seat",
  currency: "INR" as const,
  createdAt: JOINED,
  refunds: [],
  disputes: [],
  appointment: { cancellationPolicy: null },
};

const seat = {
  id: "part-1",
  appointmentId: "appt-class",
  createdAt: JOINED,
  refundWindowHours: null,
  sessionsPurchased: 8,
};

describe("leaving a class while a session is under way", () => {
  it("forfeits the first session instead of refunding the whole seat", async () => {
    // Session 1 started 55 minutes ago.
    const plan = await planSelfLeave(
      fakeTx(weekly(-55 * 60_000)),
      "class",
      "cls-1",
      seat,
      payment,
      NOW,
    );
    expect(plan).toEqual({ amountPaise: 700_000, sessions: 7 });
  });

  it("forfeits the session under way mid-series too", async () => {
    // Sessions 1–4 held; session 5 started 20 minutes ago.
    const plan = await planSelfLeave(
      fakeTx(weekly(-4 * 7 * DAY - 20 * 60_000)),
      "class",
      "cls-1",
      seat,
      payment,
      NOW,
    );
    expect(plan).toEqual({ amountPaise: 300_000, sessions: 3 });
  });
});

describe("a next session the host moved inside the window", () => {
  /** Session 1 starts in 12 h (inside the 24 h window), moved after the purchase. */
  const movedSoon = () =>
    weekly(12 * HOUR).map((o, i) =>
      i === 0 ? { ...o, movedAt: new Date(NOW.getTime() - DAY) } : o,
    );
  const leave = (retimeBy: Date | null) =>
    planSelfLeave(
      fakeTx(movedSoon(), retimeBy),
      "class",
      "cls-1",
      seat,
      payment,
      NOW,
    );

  it("waives the window for a class never re-timed", async () => {
    await expect(leave(null)).resolves.toEqual({ mode: "full", sessions: 8 });
  });

  it("keeps the window once a re-time's free leave has ended", async () => {
    await expect(leave(new Date(NOW.getTime() - HOUR))).rejects.toMatchObject({
      code: "REFUND_WINDOW_CLOSED",
    });
  });
});

describe("the ledger names the session under way", () => {
  it("keeps it out of both delivered and never-scheduled", () => {
    const ledger = seatLedgerFrom({
      N: 8,
      amountPaise: SEAT_PAISE,
      joinedAt: JOINED,
      occurrences: weekly(-3 * 7 * DAY - 20 * 60_000),
      now: NOW,
      sessionsPurchased: 8,
    });
    expect(ledger.deliveredHeld).toBe(3);
    expect(ledger.inProgressHeld).toBe(1);
    expect(ledger.remaining).toHaveLength(4);
    expect(ledger.neverScheduled).toBe(0);
  });

  it("a host cancelling the series mid-session refunds that session too", () => {
    const ledger = seatLedgerFrom({
      N: 8,
      amountPaise: SEAT_PAISE,
      joinedAt: JOINED,
      occurrences: weekly(-3 * 7 * DAY - 20 * 60_000),
      now: NOW,
      sessionsPurchased: 8,
    });
    expect(seriesCancelRefundPaise(ledger, SEAT_PAISE)).toBe(BigInt(500_000));
  });
});
