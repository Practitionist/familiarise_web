/**
 * @jest-environment node
 */

/**
 * What a released seat is owed is priced on the sessions it was sold, a count
 * fixed at purchase: the seat's stored count, or for a seat without one what
 * checkout would have sold then. It never moves with the rows placed later.
 */
import {
  releasedSeatRefundPaise,
  type LedgerOccurrence,
} from "@/lib/booking/class-series";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const FIRST = new Date("2026-11-02T10:00:00.000Z");
const startOf = (n: number) => new Date(FIRST.getTime() + (n - 1) * DAY);
const LAPSE = new Date(FIRST.getTime() + 30 * DAY);

/** The first `placed` daily sessions of an 8-session class, as the lapse run reads them. */
function placedSessions(placed: number): LedgerOccurrence[] {
  return Array.from({ length: placed }, (_, i) => {
    const startsAt = startOf(i + 1);
    const endsAt = new Date(startsAt.getTime() + HOUR);
    return {
      ordinal: i + 1,
      startsAt,
      endsAt,
      completionStatus: endsAt <= LAPSE ? "COMPLETED" : "SCHEDULED",
      movedAt: null,
    };
  });
}

/** The refund of a seat on the 8-session class, released two hours after session `afterSession` began. */
const refund = (seat: {
  amountPaise: number;
  sessionsPurchased: number | null;
  joinedAt: Date;
  placed: number;
  afterSession: number;
}) =>
  Number(
    releasedSeatRefundPaise({
      N: 8,
      amountPaise: seat.amountPaise,
      joinedAt: seat.joinedAt,
      occurrences: placedSessions(seat.placed),
      sessionsPurchased: seat.sessionsPurchased,
      releasedAt: new Date(startOf(seat.afterSession).getTime() + 2 * HOUR),
    }).refundPaise,
  );

const BEFORE_THE_CLASS = new Date(FIRST.getTime() - 20 * DAY);
const AFTER_SESSION_2 = new Date(startOf(2).getTime() + 2 * HOUR);

describe("a seat that stores the sessions it bought", () => {
  it("removed after 3 of 8 is owed ₹5,000 whether 8 or only 4 sessions are placed", () => {
    const seat = {
      amountPaise: 800_000,
      sessionsPurchased: 8,
      joinedAt: BEFORE_THE_CLASS,
      afterSession: 3,
    };
    expect(refund({ ...seat, placed: 8 })).toBe(500_000);
    expect(refund({ ...seat, placed: 4 })).toBe(500_000);
  });
});

describe("a seat with no stored count", () => {
  it("is priced on the plan's 8 sessions, not on the 4 placed so far: ₹5,000 after 3", () => {
    const seat = {
      amountPaise: 800_000,
      sessionsPurchased: null,
      joinedAt: BEFORE_THE_CLASS,
      afterSession: 3,
    };
    expect(refund({ ...seat, placed: 4 })).toBe(500_000);
    expect(refund({ ...seat, placed: 8 })).toBe(500_000);
  });

  it("bought after session 2 for ₹6,000: sold sessions 3 to 8, so ₹4,000 after session 4 however many are placed", () => {
    const seat = {
      amountPaise: 600_000,
      sessionsPurchased: null,
      joinedAt: AFTER_SESSION_2,
      afterSession: 4,
    };
    expect(refund({ ...seat, placed: 5 })).toBe(400_000);
    expect(refund({ ...seat, placed: 8 })).toBe(400_000);
  });
});
