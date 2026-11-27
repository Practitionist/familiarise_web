/**
 * @jest-environment node
 */

/**
 * The public refund policy is worded from the engine's constants, so the page
 * cannot promise a tier, window or allowance the quote does not apply.
 */
import { MAX_CONSULTEE_RESCHEDULES } from "@/lib/booking/reschedule-caps";
import {
  EVENT_REFUND_WINDOW_HOURS_DEFAULT,
  EVENT_REFUND_WINDOW_HOURS_MAX,
  PLATFORM_DEFAULT_TIERS,
} from "@/lib/payments/operations/cancellation-policy";
import {
  REFUND_POLICY_COPY,
  REFUND_TIMING_BY_RAIL,
  tierLines,
} from "@/lib/payments/operations/refund-policy-copy";

describe("refund policy copy", () => {
  it("states one line per platform tier, with the engine's thresholds and percentages", () => {
    expect(REFUND_POLICY_COPY.consultationTiers).toEqual([
      "24 hours or more before the session: full refund",
      "2 hours or more before the session: 50% refund",
      "Less than 2 hours before the session: no refund",
    ]);
    expect(REFUND_POLICY_COPY.consultationTiers).toHaveLength(
      PLATFORM_DEFAULT_TIERS.length,
    );
  });

  it("follows any ladder it is given", () => {
    expect(
      tierLines([
        { hoursBefore: 0, refundPct: 10 },
        { hoursBefore: 72, refundPct: 80 },
      ]),
    ).toEqual([
      "72 hours or more before the session: 80% refund",
      "Less than 72 hours before the session: 10% refund",
    ]);
  });

  it("names the event window and reschedule allowance the engine enforces", () => {
    expect(REFUND_POLICY_COPY.eventWindow).toContain(
      `${EVENT_REFUND_WINDOW_HOURS_DEFAULT} hours`,
    );
    expect(REFUND_POLICY_COPY.eventWindow).toContain(
      `${EVENT_REFUND_WINDOW_HOURS_MAX} hours`,
    );
    expect(REFUND_POLICY_COPY.reschedules).toContain(
      `${MAX_CONSULTEE_RESCHEDULES} times`,
    );
  });

  it("says a subscription cancelled by the expert or our team refunds the sessions not yet held, never the held ones", () => {
    expect(REFUND_POLICY_COPY.subscriptionExpertCancel).toContain(
      "every session not yet held is refunded in full",
    );
    expect(REFUND_POLICY_COPY.subscriptionExpertCancel).toContain(
      "Sessions already held are not refunded",
    );
  });

  it("words refund timing by rail, never promising card timing for credits or org funds", () => {
    expect(REFUND_TIMING_BY_RAIL.GATEWAY).toMatch(/5–7 working days/);
    expect(REFUND_TIMING_BY_RAIL.CREDITS).not.toMatch(/working days/);
    expect(REFUND_TIMING_BY_RAIL.INTERNAL).toMatch(/organisation/);
  });
});
