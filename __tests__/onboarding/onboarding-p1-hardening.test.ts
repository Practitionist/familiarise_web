/**
 * @jest-environment node
 */

/**
 * Pins for PR-1 (P0 onboarding hardening):
 *
 * 1. Email-ownership guard — the onboarding write boundary must not move a
 *    row onto an unverified address. The session email (verified at signup)
 *    is the only address a self-service write may carry.
 * 2. Verification-upload gate — `onboarding=true` uploads are authorised by
 *    the live User row (still onboarding, or eligible for add mode).
 * 3. DEGRADED write-block — server-action POSTs to /form/onboarding and the
 *    onboarding gate are blocked; GET reads stay open.
 *
 * Pure modules only — no Prisma or server-only imports here.
 */

import {
  canSubmitVerification,
  canUploadVerificationDoc,
  resolveOnboardingEmailUpdate,
} from "../../utils/onboarding-shared";
import { isWriteBlockedInDegraded } from "../../lib/maintenance-edge";
import { VerificationSubmitSchema } from "../../schemas/verifications";

describe("resolveOnboardingEmailUpdate", () => {
  it("allows the body email matching the verified session email", () => {
    expect(
      resolveOnboardingEmailUpdate({
        bodyEmail: "ada@example.com",
        sessionEmail: "ada@example.com",
      }),
    ).toEqual({ ok: true });
  });

  it("treats case and surrounding whitespace as equal", () => {
    expect(
      resolveOnboardingEmailUpdate({
        bodyEmail: "  Ada@Example.COM ",
        sessionEmail: "ada@example.com",
      }),
    ).toEqual({ ok: true });
  });

  it("rejects a self-service write moving the row to a new address", () => {
    const result = resolveOnboardingEmailUpdate({
      bodyEmail: "attacker@example.com",
      sessionEmail: "ada@example.com",
    });
    expect(result).toEqual({
      ok: false,
      error: "Email cannot be changed during onboarding",
    });
  });

  it("leaves absent/non-string emails to downstream Zod (which requires email)", () => {
    for (const bodyEmail of [undefined, null, 42, {}, []]) {
      expect(
        resolveOnboardingEmailUpdate({
          bodyEmail,
          sessionEmail: "ada@example.com",
        }),
      ).toEqual({ ok: true });
    }
  });
});

describe("canUploadVerificationDoc (reads User state, never the draft)", () => {
  const onboarding = { role: "CONSULTEE", onboardingCompleted: false };
  const learner = {
    role: "CONSULTEE",
    onboardingCompleted: true,
    consultantProfileId: null,
  };
  const expert = {
    role: "CONSULTANT",
    onboardingCompleted: true,
    consultantProfileId: "cp_1",
  };

  it("normal mode requires a consultant profile", () => {
    expect(
      canUploadVerificationDoc({
        isOnboardingMode: false,
        hasConsultantProfile: true,
        user: expert,
      }),
    ).toBe(true);
    expect(
      canUploadVerificationDoc({
        isOnboardingMode: false,
        hasConsultantProfile: false,
        user: onboarding,
      }),
    ).toBe(false);
  });

  it("onboarding mode admits a user still onboarding, whatever the draft says", () => {
    expect(
      canUploadVerificationDoc({
        isOnboardingMode: true,
        hasConsultantProfile: false,
        user: onboarding,
      }),
    ).toBe(true);
  });

  it("onboarding mode admits an onboarded learner eligible for add mode", () => {
    expect(
      canUploadVerificationDoc({
        isOnboardingMode: true,
        hasConsultantProfile: false,
        user: learner,
      }),
    ).toBe(true);
  });

  it("onboarding mode refuses an onboarded account that cannot add an identity", () => {
    expect(
      canUploadVerificationDoc({
        isOnboardingMode: true,
        hasConsultantProfile: false,
        user: { role: "STAFF", onboardingCompleted: true },
      }),
    ).toBe(false);
  });
});

describe("canSubmitVerification (review comment on #1698)", () => {
  it("requires both a consultant profile and the live CONSULTANT role", () => {
    expect(
      canSubmitVerification({ role: "CONSULTANT", hasConsultantProfile: true }),
    ).toBe(true);
    expect(
      canSubmitVerification({ role: "CONSULTEE", hasConsultantProfile: true }),
    ).toBe(false);
    expect(
      canSubmitVerification({
        role: "CONSULTANT",
        hasConsultantProfile: false,
      }),
    ).toBe(false);
    expect(
      canSubmitVerification({ role: null, hasConsultantProfile: true }),
    ).toBe(false);
  });
});

describe("DEGRADED write-block for the onboarding wizard route", () => {
  it("blocks server-action POSTs to /form/onboarding", () => {
    expect(isWriteBlockedInDegraded("/form/onboarding", "POST")).toBe(true);
  });

  it("leaves GET reads open (banner-only degraded mode)", () => {
    expect(isWriteBlockedInDegraded("/form/onboarding", "GET")).toBe(false);
  });

  it("blocks the onboarding gate's server-action POST", () => {
    expect(isWriteBlockedInDegraded("/onboarding/gate", "POST")).toBe(true);
  });

  it("does not touch unrelated wizard-adjacent POSTs", () => {
    expect(isWriteBlockedInDegraded("/form/other", "POST")).toBe(false);
  });
});

describe("VerificationSubmitSchema (review-comment fix)", () => {
  it("accepts the documented submit shape", () => {
    expect(
      VerificationSubmitSchema.safeParse({
        linkedinUrl: "https://linkedin.com/in/ada",
        notes: "hello",
        documentIds: ["doc-1"],
      }).success,
    ).toBe(true);
    expect(VerificationSubmitSchema.safeParse({}).success).toBe(true);
  });

  it("rejects null, exotic documentIds, and unknown keys", () => {
    expect(VerificationSubmitSchema.safeParse(null).success).toBe(false);
    expect(VerificationSubmitSchema.safeParse("nope").success).toBe(false);
    expect(
      VerificationSubmitSchema.safeParse({ documentIds: "doc-1" }).success,
    ).toBe(false);
    expect(
      VerificationSubmitSchema.safeParse({ documentIds: [42] }).success,
    ).toBe(false);
    expect(VerificationSubmitSchema.safeParse({ nope: 1 }).success).toBe(false);
  });
});
