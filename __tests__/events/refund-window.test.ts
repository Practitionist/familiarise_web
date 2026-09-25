/**
 * @jest-environment node
 */

/**
 * #1780 row 2 — the host's free-cancellation window on a class or webinar
 * plan is 24–168 whole hours; a seat reads its own snapshot, then the plan,
 * then the 24 h default.
 */

import { refundWindowHoursSchema } from "@/lib/booking/refund-window";
import { eventRefundWindowHours } from "@/lib/payments/operations/cancellation-policy";

it("accepts 24–168 whole hours or null, and reads null as 24", () => {
  expect(refundWindowHoursSchema.safeParse(12).success).toBe(false);
  expect(refundWindowHoursSchema.safeParse(168).success).toBe(true);
  expect(refundWindowHoursSchema.safeParse(null).success).toBe(true);
  expect(eventRefundWindowHours(null, null)).toBe(24);
  expect(eventRefundWindowHours(null, 72)).toBe(72);
  expect(eventRefundWindowHours(48, 72)).toBe(48);
});
