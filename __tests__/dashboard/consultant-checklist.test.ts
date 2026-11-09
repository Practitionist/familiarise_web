import {
  deriveConsultantChecklist,
  payoutAccountReady,
  profileFieldsComplete,
  type ConsultantChecklistSnapshot,
} from "@/lib/dashboard/consultant-checklist";
import { PROFILE_COMPLETION_WEIGHTS } from "@/lib/profiles/profile-completion";
import { payoutRequirements } from "@/lib/payments/payouts/payout-requirements";

const ID = "c1";

const fullProfile = {
  description: "A".repeat(40),
  headline: "Senior engineer and mentor",
  experience: 8,
  hasDomainDetail: true,
  hasWorkExperience: true,
  hasImage: true,
};

const payoutDone = payoutRequirements({
  consultantProfileId: ID,
  taxInfo: { panLast4: "1234", gstin: null, taxEntityType: "INDIVIDUAL" },
  defaultAccount: { isVerified: true },
  earningsCount: 0,
  isIndianResident: true,
  livePayoutsEnabled: true,
});

const setUp: ConsultantChecklistSnapshot = {
  verificationStatus: "VERIFIED",
  profile: fullProfile,
  hasAvailability: true,
  hasPublishedOffering: true,
  payout: payoutDone,
};

const stepOf = (s: ConsultantChecklistSnapshot, key: string) =>
  deriveConsultantChecklist(s, ID).find((step) => step.key === key);

describe("deriveConsultantChecklist", () => {
  it("returns the five steps in order, each with an href under the expert's base", () => {
    const steps = deriveConsultantChecklist(setUp, ID);
    expect(steps.map((s) => s.key)).toEqual([
      "verify",
      "profile",
      "hours",
      "offering",
      "payout",
    ]);
    for (const step of steps) {
      expect(step.href.startsWith(`/dashboard/consultant/${ID}/`)).toBe(true);
    }
  });

  it("marks every step done for a fully set-up expert", () => {
    expect(deriveConsultantChecklist(setUp, ID).every((s) => s.done)).toBe(
      true,
    );
  });

  it("opens every step for a fresh expert", () => {
    const fresh: ConsultantChecklistSnapshot = {
      verificationStatus: "PENDING_VERIFICATION",
      profile: {
        description: null,
        headline: null,
        experience: null,
        hasDomainDetail: false,
        hasWorkExperience: false,
        hasImage: false,
      },
      hasAvailability: false,
      hasPublishedOffering: false,
      payout: payoutRequirements({
        consultantProfileId: ID,
        taxInfo: null,
        defaultAccount: null,
        earningsCount: 0,
        isIndianResident: true,
        livePayoutsEnabled: true,
      }),
    };
    expect(deriveConsultantChecklist(fresh, ID).filter((s) => s.done)).toEqual(
      [],
    );
  });

  it.each(["PENDING_VERIFICATION", "UNDER_REVIEW", "REJECTED"] as const)(
    "keeps verify open while the status is %s",
    (verificationStatus) => {
      expect(stepOf({ ...setUp, verificationStatus }, "verify")?.done).toBe(
        false,
      );
    },
  );

  describe("profile", () => {
    it("needs every non-checklist field", () => {
      expect(profileFieldsComplete(fullProfile)).toBe(true);
      for (const patch of [
        { description: "too short" },
        { headline: "  " },
        { experience: 0 },
        { hasDomainDetail: false },
        { hasWorkExperience: false },
        { hasImage: false },
      ]) {
        expect(profileFieldsComplete({ ...fullProfile, ...patch })).toBe(false);
      }
    });

    it("does not double-count availability, plan or verification", () => {
      const fieldsMax =
        100 -
        PROFILE_COMPLETION_WEIGHTS.availability -
        PROFILE_COMPLETION_WEIGHTS.plan -
        PROFILE_COMPLETION_WEIGHTS.verified;
      expect(fieldsMax).toBe(55);
      const unverifiedNoHours: ConsultantChecklistSnapshot = {
        ...setUp,
        verificationStatus: "PENDING_VERIFICATION",
        hasAvailability: false,
        hasPublishedOffering: false,
      };
      expect(stepOf(unverifiedNoHours, "profile")?.done).toBe(true);
    });
  });

  it("opens hours and offering independently", () => {
    expect(stepOf({ ...setUp, hasAvailability: false }, "hours")?.done).toBe(
      false,
    );
    expect(
      stepOf({ ...setUp, hasPublishedOffering: false }, "offering")?.done,
    ).toBe(false);
  });

  describe("payout", () => {
    const base = {
      consultantProfileId: ID,
      earningsCount: 0,
      isIndianResident: true,
      livePayoutsEnabled: true,
    };

    it("stays done when only a GSTIN is outstanding", () => {
      expect(payoutDone.eventuallyDue.map((r) => r.code)).toEqual(["GSTIN"]);
      expect(payoutAccountReady(payoutDone)).toBe(true);
    });

    it("stays open when the account is missing (blocked)", () => {
      const payout = payoutRequirements({
        ...base,
        taxInfo: { panLast4: "1234", gstin: null, taxEntityType: "COMPANY" },
        defaultAccount: null,
      });
      expect(payout.blocked).toBe(true);
      expect(payoutAccountReady(payout)).toBe(false);
    });

    it("stays open when the account is unverified (blocked)", () => {
      const payout = payoutRequirements({
        ...base,
        taxInfo: { panLast4: "1234", gstin: null, taxEntityType: "COMPANY" },
        defaultAccount: { isVerified: false },
      });
      expect(payout.blocked).toBe(true);
      expect(stepOf({ ...setUp, payout }, "payout")?.done).toBe(false);
    });

    it("stays open when PAN is missing, due now or later", () => {
      for (const earningsCount of [0, 3]) {
        const payout = payoutRequirements({
          ...base,
          earningsCount,
          taxInfo: null,
          defaultAccount: { isVerified: true },
        });
        expect(payout.blocked).toBe(false);
        expect(payoutAccountReady(payout)).toBe(false);
      }
    });
  });
});
