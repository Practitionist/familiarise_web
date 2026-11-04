/**
 * @jest-environment node
 */

/**
 * The train-B refund math on the worked plan: ₹15,600 for 26 weeks × 3 = 78
 * sessions (₹200 each). A support partial refund of k sessions takes their
 * share now and removes them from the plan; the plan-end settlement keeps
 * floor(A × unused / T) − already returned with T = the sessions sold, so the
 * two never pay a session twice.
 */
jest.mock("../../lib/prisma", () => ({ __esModule: true, default: {} }));

import { planEndMarker } from "../../scripts/appointments/settle-cancelled-sessions";
import { sessionShareOf } from "../../lib/booking/plan-refund";
import {
  purchaseTermsOf,
  subscriptionEntitlement,
} from "../../lib/booking/entitlement";
import { STAFF_REFUND_PER_PAYMENT_PAISE } from "../../lib/support/staff-refund-limits";

const A = 1_560_000;
const START = new Date("2026-01-05T12:30:00.000Z"); // 18:00 in Kolkata
const ZONE = "Asia/Kolkata";
const plan = {
  sessionsPerWeek: 3,
  sessionDurationInHours: 1,
  durationInMonths: 6,
  durationInWeeks: 26,
};
const T = purchaseTermsOf(plan, START, ZONE).sessionsTotal;

const payment = (refunds: { amountPaise: number; status: string }[] = []) => ({
  id: "pay-1",
  amount: A,
  refunds,
  disputes: [],
});

const marker = (
  unused: number,
  refunds: { amountPaise: number; status: string }[] = [],
) => planEndMarker("sub-1", payment(refunds), unused, T)?.amountPaise ?? 0;

describe("the worked plan sells 78 sessions", () => {
  it("is 26 weeks × 3 a week at ₹200 each", () => {
    expect(T).toBe(78);
    expect(sessionShareOf(A, 1, T)).toBe(20_000);
  });
});

describe("plan end", () => {
  it("70 delivered, 8 unused → ₹1,600", () => {
    expect(marker(78 - 70)).toBe(160_000);
  });

  it("an extension delivers 6 of the 8 → ₹400 for the 2 left", () => {
    expect(marker(2)).toBe(40_000);
  });

  it("the expert can't do the weeks → the plan end settles ₹1,600", () => {
    expect(marker(8)).toBe(160_000);
  });
});

describe("support partial refund of 9 missed sessions in week 10", () => {
  const share = sessionShareOf(A, 9, T);

  it("refunds ₹1,800, inside the STAFF cap", () => {
    expect(share).toBe(180_000);
    expect(share).toBeLessThanOrEqual(STAFF_REFUND_PER_PAYMENT_PAISE);
  });

  it("leaves 69 schedulable sessions", () => {
    const entitlement = subscriptionEntitlement({
      sessionsTotal: T,
      sessionsRefunded: 9,
      sessionsPerWeek: 3,
      durationInMonths: 6,
      occurrences: [],
      schedulingPeriodStartsAt: START,
      schedulingTimezone: ZONE,
      planEndsAt: purchaseTermsOf(plan, START, ZONE).planEndsAt,
      now: new Date("2026-03-09T06:00:00.000Z"),
    });
    expect(entitlement.total).toBe(69);
    expect(entitlement.remaining).toBe(69);
  });

  it("then plan end with 61 delivered → ₹1,600 for the 8 still unused", () => {
    const returned = [{ amountPaise: share, status: "SUCCEEDED" }];
    expect(marker(78 - 61, returned)).toBe(160_000);
    // No session is paid twice: the support share plus the plan-end share is
    // exactly the 17 undelivered sessions' worth.
    expect(share + marker(78 - 61, returned)).toBe(sessionShareOf(A, 17, T));
  });
});

describe("severe failure: platform cancel in week 10 with 27 delivered", () => {
  it("is ₹10,200, above the STAFF cap so an ADMIN sends it", () => {
    const amount = sessionShareOf(A, 78 - 27, T);
    expect(amount).toBe(1_020_000);
    expect(amount).toBeGreaterThan(STAFF_REFUND_PER_PAYMENT_PAISE);
  });
});

describe("a session count is capped by what the plan sold", () => {
  it("never shares more than the whole payment", () => {
    expect(sessionShareOf(A, 100, T)).toBe(A);
    expect(sessionShareOf(A, 0, T)).toBe(0);
  });
});
