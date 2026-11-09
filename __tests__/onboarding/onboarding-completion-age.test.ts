jest.mock("@/lib/compliance/dpdp", () => ({
  ensureConsentPurposes: jest.fn(),
}));
jest.mock("@/lib/newsletter/consent-link", () => ({
  subscribeForMarketingConsent: jest.fn(),
}));

import { claimOnboardingCompletion } from "@/utils/onboarding-completion";
import type { Tx } from "@/lib/prisma";

const updateMany = jest.fn();
const tx = { user: { updateMany } } as unknown as Tx;

function yearsAgo(years: number): Date {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - years);
  return d;
}

beforeEach(() => {
  jest.clearAllMocks();
  updateMany.mockResolvedValue({ count: 1 });
});

describe("claimOnboardingCompletion age stamp", () => {
  it("stamps adultConfirmedAt from an 18+ date of birth", async () => {
    await claimOnboardingCompletion(tx, "u1", { dateOfBirth: yearsAgo(30) });
    expect(updateMany.mock.calls[0][0].data.adultConfirmedAt).toBeInstanceOf(
      Date,
    );
  });

  it("does not stamp for an under-18 date of birth", async () => {
    await claimOnboardingCompletion(tx, "u1", { dateOfBirth: yearsAgo(16) });
    expect(updateMany.mock.calls[0][0].data.adultConfirmedAt).toBeNull();
  });
});
