/**
 * @jest-environment node
 */

/**
 * #1780 E-1 — a learner may leave a class series with every undelivered
 * session refunded once the host has cancelled three sessions or a quarter
 * of the series, whichever comes first.
 */

import { exitRightFor } from "@/lib/booking/class-series";

it("3 misses of 12 → exit right; 2 of 12 → none; 2 of 8 (25 %) → exit right", () => {
  expect(exitRightFor(3, 12)).toBe(true);
  expect(exitRightFor(2, 12)).toBe(false);
  expect(exitRightFor(2, 8)).toBe(true);
});
