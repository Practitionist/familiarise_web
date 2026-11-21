/**
 * The organisation's roster tells its admin an invited expert is not bookable
 * yet: the badge reads "Waiting for verification" until the platform verifies them.
 */

import { expertVerificationLabel } from "@/lib/labels/org-labels";

it("labels an expert who is not verified as waiting for verification", () => {
  expect(expertVerificationLabel(false)).toBe("Waiting for verification");
  expect(expertVerificationLabel(true)).toBe("Verified");
});
