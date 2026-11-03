/**
 * A direct checkout the buyer is still paying for is not a request the expert
 * can answer: allocation (every mode) and approval refuse it with 409
 * CHECKOUT_IN_PROGRESS until the payment lands or lapses.
 */

import "./setup";

import {
  assertNoLiveCheckoutHold,
  isLiveCheckoutHold,
} from "@/lib/booking/request-cohort";
import { BookingRuleError } from "@/lib/booking/booking-rule-error";
import { classifyError } from "@/lib/booking/allocation/classify";

const now = new Date("2030-01-01T10:00:00Z");
const live = {
  paymentStatus: "PENDING",
  expiresAt: new Date("2030-01-01T10:10:00Z"),
};
const lapsed = {
  paymentStatus: "PENDING",
  expiresAt: new Date("2030-01-01T09:50:00Z"),
};
const paid = { paymentStatus: "SUCCEEDED", expiresAt: null };

describe("isLiveCheckoutHold", () => {
  it("is a direct checkout with a live unpaid payment", () => {
    expect(isLiveCheckoutHold("DIRECT_CHECKOUT", [live], now)).toBe(true);
  });
  it.each([
    ["a lapsed payment", "DIRECT_CHECKOUT", [lapsed]],
    ["a paid checkout", "DIRECT_CHECKOUT", [live, paid]],
    ["a submitted request", "REQUEST_SUBMITTED", [live]],
    ["no payment", "DIRECT_CHECKOUT", []],
  ])("is not %s", (_label, source, payments) => {
    expect(isLiveCheckoutHold(source, payments, now)).toBe(false);
  });
});

describe("assertNoLiveCheckoutHold", () => {
  const db = (live: number) => ({
    consultation: { count: jest.fn(async () => live) },
    subscription: { count: jest.fn(async () => live) },
  });

  it("refuses with a typed 409 and plain copy while the buyer is paying", async () => {
    const refusal = await assertNoLiveCheckoutHold(
      db(1),
      "consultation",
      "c-1",
      now,
    ).catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(BookingRuleError);
    expect((refusal as BookingRuleError).code).toBe("CHECKOUT_IN_PROGRESS");
    expect((refusal as BookingRuleError).httpStatus).toBe(409);
    expect((refusal as Error).message).toMatch(/still paying/);
    expect(classifyError(refusal)).toEqual({
      errorCode: "CHECKOUT_IN_PROGRESS",
      httpStatus: 409,
    });
  });

  it("lets an answerable booking through", async () => {
    await expect(
      assertNoLiveCheckoutHold(db(0), "subscription", "s-1", now),
    ).resolves.toBeUndefined();
  });
});
