/**
 * @jest-environment node
 */

/**
 * Pins for PR-3 (onboarding/org email twins): pure subject + role-label
 * helpers. Template rendering stays out of unit tests (no render test
 * exists to copy); senders are thin guarded wrappers over
 * loadEmailRecipients/sendToRecipients and are covered by their own suites.
 */

import { verificationDecidedSubject } from "../../emails/verification/VerificationDecidedEmail";
import {
  memberRoleLabel,
  orgMembershipChangedSubject,
} from "../../emails/organizations/OrgMembershipChangedEmail";
import { orgCreatedSubject } from "../../emails/organizations/OrgCreatedEmail";
import { orgWelcomeSubject } from "../../emails/organizations/OrgWelcomeEmail";

describe("verificationDecidedSubject", () => {
  it("names the verified outcome", () => {
    expect(verificationDecidedSubject("VERIFIED")).toBe(
      "Your Familiarise expert profile is verified",
    );
  });

  it("names the rejected outcome", () => {
    expect(verificationDecidedSubject("REJECTED")).toBe(
      "Your Familiarise expert profile was not approved",
    );
  });

  it("asks for more info when pending verification", () => {
    expect(verificationDecidedSubject("PENDING_VERIFICATION")).toBe(
      "We need more information for your expert profile",
    );
  });
});

describe("memberRoleLabel", () => {
  it("labels every MemberRole in words, not enum caps", () => {
    expect(memberRoleLabel("OWNER")).toBe("Owner");
    expect(memberRoleLabel("MAINTAINER")).toBe("Maintainer");
    expect(memberRoleLabel("BILLING_ADMIN")).toBe("Billing admin");
    expect(memberRoleLabel("MANAGER")).toBe("Manager");
    expect(memberRoleLabel("EXPERT")).toBe("Expert");
    expect(memberRoleLabel("LEARNER")).toBe("Learner");
    expect(memberRoleLabel("SUPPORT")).toBe("Support");
  });

  it("passes unknown strings through instead of blanking", () => {
    expect(memberRoleLabel("member")).toBe("member");
    expect(memberRoleLabel("ORG_LEARNER")).toBe("ORG_LEARNER");
  });
});

describe("orgMembershipChangedSubject", () => {
  it("subjects the removal notice with the org name", () => {
    expect(
      orgMembershipChangedSubject({ kind: "REMOVED", orgName: "Acme" }),
    ).toBe("You were removed from Acme");
  });

  it("subjects the role-change notice with the org name", () => {
    expect(
      orgMembershipChangedSubject({ kind: "ROLE_CHANGED", orgName: "Acme" }),
    ).toBe("Your role in Acme changed");
  });
});

describe("orgCreatedSubject", () => {
  it("names the created org", () => {
    expect(orgCreatedSubject("Acme")).toBe(
      "Your organisation Acme is created — what happens next",
    );
  });
});

describe("orgWelcomeSubject", () => {
  it("welcomes the joiner to the org", () => {
    expect(orgWelcomeSubject("Acme")).toBe("Welcome to Acme on Familiarise");
  });
});
