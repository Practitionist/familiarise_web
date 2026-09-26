/**
 * @jest-environment node
 */

/** Q10 (#1527): typed confirm starts at exactly ₹10,000, for both number and bigint paise. */

import {
  TYPED_CONFIRM_THRESHOLD_PAISE,
  needsTypedConfirm,
} from "@/lib/ui/typed-confirm";

describe("needsTypedConfirm (#1527 Q10)", () => {
  it("pins the threshold at ₹10,000 inclusive", () => {
    expect(TYPED_CONFIRM_THRESHOLD_PAISE).toBe(1_000_000);
    expect(needsTypedConfirm(999_999)).toBe(false);
    expect(needsTypedConfirm(1_000_000)).toBe(true);
    expect(needsTypedConfirm(BigInt(999_999))).toBe(false);
    expect(needsTypedConfirm(BigInt(1_000_000))).toBe(true);
  });
});
