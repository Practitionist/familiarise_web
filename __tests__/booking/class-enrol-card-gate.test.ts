/**
 * @jest-environment node
 */

/**
 * The class card offers Enrol exactly where checkout sells a seat: once every
 * session of the plan is planned. A session the host cancelled still counts
 * while its make-up is owed inside the make-up window; a class that is only
 * partly scheduled does not open.
 */

import {
  deriveBatchCards,
  plannedSessionCount,
  type BatchCardClass,
} from "@/lib/booking/batch-cards";
import { MAKEUP_WINDOW_DAYS } from "@/lib/booking/misses";

const NOW = new Date("2026-11-17T06:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const at = (days: number) => new Date(NOW.getTime() + days * DAY);

const session = (
  ordinal: number,
  days: number,
  over: { completionStatus?: string; hostCancelledAt?: Date | null } = {},
) => ({
  ordinal,
  startsAt: at(days),
  endsAt: new Date(at(days).getTime() + 60 * 60 * 1000),
  completionStatus: "SCHEDULED",
  deletedAt: null,
  hostCancelledAt: null as Date | null,
  ...over,
});

const hostCancelled = (
  ordinal: number,
  days: number,
  cancelledDaysAgo: number,
) =>
  session(ordinal, days, {
    completionStatus: "CANCELLED",
    hostCancelledAt: at(-cancelledDaysAgo),
  });

const plan = {
  price: 400_000,
  totalSessions: 4,
  sessionsPerWeek: 1,
  maxParticipants: 10,
  lateJoinUntilSession: 3,
};

const card = (occurrences: ReturnType<typeof session>[]) => {
  const cls = {
    id: "class-1",
    status: "SCHEDULED",
    appointment: { occurrences, _count: { participants: 0 } },
  } as unknown as BatchCardClass;
  return deriveBatchCards(plan, [cls], NOW)[0];
};

const FULL = [session(1, 2), session(2, 9), session(3, 16), session(4, 23)];

describe("the class card's Enrol follows checkout's fully-scheduled gate", () => {
  it("opens once all four sessions are planned", () => {
    expect(plannedSessionCount(FULL, NOW)).toBe(4);
    expect(card(FULL).canEnrol).toBe(true);
  });

  it("stays closed for a class with three of four sessions placed", () => {
    const partly = FULL.slice(0, 3);
    expect(plannedSessionCount(partly, NOW)).toBe(3);
    expect(card(partly)).toMatchObject({
      canEnrol: false,
      enrolment: { state: "open" },
    });
  });

  it("counts a released session awaiting its new time, as checkout does", () => {
    const moving = [
      FULL[0],
      session(2, 9, { completionStatus: "RESCHEDULED" }),
      FULL[2],
      FULL[3],
    ];
    expect(plannedSessionCount(moving, NOW)).toBe(4);
    expect(card(moving).canEnrol).toBe(true);
  });

  it("counts a host-cancelled session while its make-up is still owed", () => {
    const owed = [FULL[0], hostCancelled(2, 9, 1), FULL[2], FULL[3]];
    expect(plannedSessionCount(owed, NOW)).toBe(4);
    expect(card(owed).canEnrol).toBe(true);
  });

  it("stops counting it once the make-up window has closed", () => {
    const lapsed = [
      FULL[0],
      hostCancelled(2, 9, MAKEUP_WINDOW_DAYS + 1),
      FULL[2],
      FULL[3],
    ];
    expect(plannedSessionCount(lapsed, NOW)).toBe(3);
    expect(card(lapsed).canEnrol).toBe(false);
  });

  it("never counts a cancelled session twice once its make-up is placed", () => {
    // Three sessions were ever placed; one was cancelled and made up. The
    // fourth was never scheduled, so the class is still short.
    const madeUp = [FULL[0], hostCancelled(2, 9, 1), session(2, 11), FULL[2]];
    expect(plannedSessionCount(madeUp, NOW)).toBe(3);
    expect(card(madeUp).canEnrol).toBe(false);
  });

  it("does not count a session cancelled by anyone but the host", () => {
    const gone = [
      FULL[0],
      session(2, 9, { completionStatus: "CANCELLED" }),
      FULL[2],
      FULL[3],
    ];
    expect(plannedSessionCount(gone, NOW)).toBe(3);
    expect(card(gone).canEnrol).toBe(false);
  });
});
