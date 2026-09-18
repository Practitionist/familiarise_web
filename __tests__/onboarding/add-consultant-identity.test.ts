/**
 * @jest-environment node
 */
/**
 * PR-6 — who may add a consultant identity to an onboarded account. The
 * layout guard, the action and the server core share this one decision.
 */

import { canAddConsultantIdentity } from "../../utils/onboarding-shared";

describe("canAddConsultantIdentity", () => {
  it("admits an onboarded learner or org operator with no consultant profile", () => {
    expect(
      canAddConsultantIdentity({
        role: "CONSULTEE",
        onboardingCompleted: true,
        consultantProfileId: null,
      }),
    ).toBe(true);
    expect(
      canAddConsultantIdentity({
        role: "ORG_WORKSPACE",
        onboardingCompleted: true,
        consultantProfileId: null,
      }),
    ).toBe(true);
  });

  it("refuses a user still in onboarding — the normal wizard owns them", () => {
    expect(
      canAddConsultantIdentity({
        role: "CONSULTEE",
        onboardingCompleted: false,
        consultantProfileId: null,
      }),
    ).toBe(false);
  });

  it("refuses an account that already has a consultant profile", () => {
    expect(
      canAddConsultantIdentity({
        role: "CONSULTANT",
        onboardingCompleted: true,
        consultantProfileId: "cp1",
      }),
    ).toBe(false);
  });

  it("refuses staff, admin and unknown roles", () => {
    for (const role of ["STAFF", "ADMIN", null, undefined, "constructor"]) {
      expect(
        canAddConsultantIdentity({
          role,
          onboardingCompleted: true,
          consultantProfileId: null,
        }),
      ).toBe(false);
    }
  });
});
