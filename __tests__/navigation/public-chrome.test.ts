import {
  isChromeHidden,
  needsHeaderSpacer,
} from "@/lib/navigation/public-chrome";

describe("public chrome on checkout", () => {
  it("keeps the site header on the trial checkout card and hides it on the two-column checkouts", () => {
    expect(isChromeHidden("/checkout/plans/trial/t1")).toBe(false);
    expect(needsHeaderSpacer("/checkout/plans/trial/t1")).toBe(true);
    expect(isChromeHidden("/checkout/plans/consultation/p1")).toBe(true);
    expect(isChromeHidden("/checkout/pay/pay1")).toBe(true);
  });
});
