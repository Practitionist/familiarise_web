/**
 * @jest-environment node
 */

/**
 * Checkout renews its grant at the top of every Serializable attempt, so a TTL
 * only has to outlive one attempt plus slack. A key held by a crashed
 * invocation (the event key is shared by every buyer of that event) must stall
 * sales for seconds, not minutes.
 *
 * Asserts the IMPORTED constant: source-text regexes break on formatter
 * changes and pass through duplicate-key overrides.
 */

import { CHECKOUT_LOCK_TTL_MS } from "../../utils/appointmentlock";

describe("CHECKOUT_LOCK_TTL_MS", () => {
  it("sizes every event key to one attempt, never minutes", () => {
    for (const type of ["SUBSCRIPTION", "WEBINAR", "CLASS"]) {
      expect(CHECKOUT_LOCK_TTL_MS[type]).toBeLessThanOrEqual(60_000);
      // One 25 s attempt plus the 10 s slack checkout renews to.
      expect(CHECKOUT_LOCK_TTL_MS[type]).toBeGreaterThanOrEqual(35_000);
    }
  });

  it("keeps the consultation slot budget", () => {
    expect(CHECKOUT_LOCK_TTL_MS.CONSULTATION).toBe(60_000);
  });
});
