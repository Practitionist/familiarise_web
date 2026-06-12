/**
 * @jest-environment node
 */

/**
 * Pins the dispute state machine after the CLOSED terminal landed (backlog
 * triage PR): Razorpay's `closed` is an ended-without-verdict terminal, so it
 * must be reachable from the live states, emit nothing, and never be re-driven
 * by a delayed or replayed webhook.
 */

import {
  isLegalDisputeTransition,
  TERMINAL_DISPUTE_STATUSES,
} from "@/lib/payments/dispute-status";

describe("isLegalDisputeTransition", () => {
  it("treats CLOSED as terminal alongside WON/LOST/CHARGE_REFUNDED", () => {
    expect(TERMINAL_DISPUTE_STATUSES).toEqual(
      expect.arrayContaining(["WON", "LOST", "CHARGE_REFUNDED", "CLOSED"]),
    );
    for (const next of [
      "NEEDS_RESPONSE",
      "UNDER_REVIEW",
      "WON",
      "LOST",
    ] as const) {
      expect(isLegalDisputeTransition("CLOSED", next)).toBe(false);
    }
  });

  it("allows both live states to close without a verdict", () => {
    expect(isLegalDisputeTransition("NEEDS_RESPONSE", "CLOSED")).toBe(true);
    expect(isLegalDisputeTransition("UNDER_REVIEW", "CLOSED")).toBe(true);
  });

  it("keeps warnings out of CLOSED — early warnings end via WARNING_CLOSED", () => {
    expect(isLegalDisputeTransition("WARNING_NEEDS_RESPONSE", "CLOSED")).toBe(
      false,
    );
    expect(isLegalDisputeTransition("WARNING_UNDER_REVIEW", "CLOSED")).toBe(
      false,
    );
  });

  it("rejects re-driving any terminal verdict (replayed webhook)", () => {
    for (const from of TERMINAL_DISPUTE_STATUSES) {
      expect(isLegalDisputeTransition(from, "NEEDS_RESPONSE")).toBe(false);
    }
  });

  it("stays idempotent on same-status redelivery", () => {
    expect(isLegalDisputeTransition("CLOSED", "CLOSED")).toBe(true);
    expect(isLegalDisputeTransition("UNDER_REVIEW", "UNDER_REVIEW")).toBe(true);
  });
});
