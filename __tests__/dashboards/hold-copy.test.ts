import {
  AWAITING_ORG_LABEL,
  ORG_PAYOUTS_PARKED_COPY,
  newExpertHoldCopy,
  paidOutHint,
} from "@/lib/dashboard/hold-copy";
import { PAYOUT_CONSTANTS } from "@/lib/payments/payouts/constants";

describe("hold copy", () => {
  it("states the new-expert hold from the payout constants", () => {
    const copy = newExpertHoldCopy();
    expect(copy).toContain(
      `${PAYOUT_CONSTANTS.NEW_EXPERT_EXTRA_HOLD_DAYS} extra days`,
    );
    expect(copy).toContain(`${PAYOUT_CONSTANTS.NEW_EXPERT_TENURE_DAYS} days`);
    expect(copy).toContain(
      `₹${(PAYOUT_CONSTANTS.NEW_EXPERT_LIFETIME_SHARE_PAISE / 100).toLocaleString("en-IN")}`,
    );
    expect(copy).toContain("₹10,000");
  });

  it("names the trust-parked tile and the parked org payout in plain words", () => {
    expect(AWAITING_ORG_LABEL).toBe("Awaiting organisation verification");
    expect(ORG_PAYOUTS_PARKED_COPY).toMatch(/held for you, not failed/);
  });

  it("shows the TDS withheld beside the after-TDS paid-out figure only when there is some", () => {
    expect(paidOutHint(3, 0)).toBe("3 payouts");
    expect(paidOutHint(3, 125_000)).toBe("3 payouts · ₹1,250.00 TDS withheld");
    expect(paidOutHint(1, 105)).toBe("1 payouts · ₹1.05 TDS withheld");
    expect(paidOutHint(1, 40)).toBe("1 payouts · ₹0.40 TDS withheld");
  });
});
