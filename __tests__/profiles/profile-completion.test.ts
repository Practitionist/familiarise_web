/**
 * #698 OB-1 — pins the completion weights so the score only moves on purpose.
 */

import {
  calculateProfileCompletion,
  PROFILE_COMPLETION_WEIGHTS,
  type ProfileCompletionInput,
} from "../../lib/profiles/profile-completion";

const empty: ProfileCompletionInput = {
  description: null,
  headline: null,
  experience: null,
  hasDomainDetail: false,
  hasAvailability: false,
  hasPlan: false,
  hasWorkExperience: false,
  hasImage: false,
  isVerified: false,
};

const full: ProfileCompletionInput = {
  description: "A".repeat(40),
  headline: "Senior engineer and mentor",
  experience: 8,
  hasDomainDetail: true,
  hasAvailability: true,
  hasPlan: true,
  hasWorkExperience: true,
  hasImage: true,
  isVerified: true,
};

describe("calculateProfileCompletion", () => {
  it("weights sum to exactly 100", () => {
    const total = Object.values(PROFILE_COMPLETION_WEIGHTS).reduce(
      (a, b) => a + b,
      0,
    );
    expect(total).toBe(100);
  });

  it("scores 0 for an empty profile and 100 for a complete one", () => {
    expect(calculateProfileCompletion(empty)).toBe(0);
    expect(calculateProfileCompletion(full)).toBe(100);
  });

  it("does not count a description under 40 characters", () => {
    expect(
      calculateProfileCompletion({ ...empty, description: "Too short" }),
    ).toBe(0);
    expect(
      calculateProfileCompletion({ ...empty, description: "A".repeat(40) }),
    ).toBe(PROFILE_COMPLETION_WEIGHTS.description);
  });

  it("verification and availability are the two largest single inputs after description", () => {
    expect(calculateProfileCompletion({ ...empty, isVerified: true })).toBe(
      PROFILE_COMPLETION_WEIGHTS.verified,
    );
    expect(
      calculateProfileCompletion({ ...empty, hasAvailability: true }),
    ).toBe(PROFILE_COMPLETION_WEIGHTS.availability);
  });
});
