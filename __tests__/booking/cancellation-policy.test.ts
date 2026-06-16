/**
 * @jest-environment node
 */

/**
 * B1 — the snapshot-at-booking refund policy. The tiers frozen onto the
 * Appointment at checkout decide the refund; consultant-initiated always
 * refunds in full; pre-feature bookings (null snapshot) get the platform
 * defaults.
 */

import {
  computeRefundPct,
  parsePolicySnapshot,
  resolveCancellationPolicySnapshot,
  PLATFORM_DEFAULT_TIERS,
} from "@/lib/payments/operations/cancellation-policy";

describe("computeRefundPct — platform default tiers", () => {
  it.each([
    [48, 100], // two days out → full refund
    [24, 100], // exactly at the 24h boundary → full refund
    [23.9, 50], // inside a day → half
    [2, 50], // exactly at the 2h boundary → half
    [1.5, 0], // inside two hours → nothing
    [0, 0], // at start time → nothing
  ])("%s hours before start → %s%%", (hours, pct) => {
    expect(computeRefundPct(null, hours, false)).toBe(pct);
  });

  it("refunds nothing after the booking started", () => {
    expect(computeRefundPct(null, -3, false)).toBe(0);
  });

  it("consultant-initiated always refunds 100%, even past start", () => {
    expect(computeRefundPct(null, 1, true)).toBe(100);
    expect(computeRefundPct(null, -3, true)).toBe(100);
  });
});

describe("snapshot freezing", () => {
  it("a frozen snapshot wins over whatever the defaults become later", () => {
    const generous = {
      ...resolveCancellationPolicySnapshot(),
      tiers: [{ hoursBefore: 0, refundPct: 100 }],
    };
    // 1 hour before start: platform default says 0, the buyer's frozen
    // terms say 100 — the snapshot governs.
    expect(computeRefundPct(generous, 1, false)).toBe(100);
  });

  it("round-trips through the Json column", () => {
    const snap = resolveCancellationPolicySnapshot({
      orgPolicyText: "Org prose policy",
    });
    const parsed = parsePolicySnapshot(JSON.parse(JSON.stringify(snap)));
    expect(parsed).not.toBeNull();
    expect(parsed!.tiers).toEqual(PLATFORM_DEFAULT_TIERS);
    expect(parsed!.orgPolicyText).toBe("Org prose policy");
  });

  it("rejects malformed snapshots (falls back to defaults at the call site)", () => {
    expect(parsePolicySnapshot(null)).toBeNull();
    expect(parsePolicySnapshot("v1")).toBeNull();
    expect(parsePolicySnapshot({ version: 2, tiers: [] })).toBeNull();
    expect(parsePolicySnapshot({ version: 1 })).toBeNull();
  });
});
