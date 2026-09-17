/**
 * @jest-environment node
 */

/**
 * Pins for PR-1 (P0 onboarding hardening):
 *
 * 1. Email-ownership guard — the onboarding write boundary must not move a
 *    row onto an unverified address. The session email (verified at signup)
 *    is the only address a self-service write may carry.
 * 2. Verification-upload gate — transient `onboarding=true` uploads create no
 *    DB row, so the per-verification count cap cannot see them. Only the
 *    consultant wizard (draft role CONSULTANT) may use that mode.
 * 3. DEGRADED write-block — server-action POSTs to /form/onboarding must be
 *    blocked like the equivalent PATCH route; GET reads stay open.
 *
 * Pure modules only — no Prisma or server-only imports here.
 */

import {
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
        isPrivileged: false,
      }),
    ).toEqual({ ok: true });
  });

  it("treats case and surrounding whitespace as equal", () => {
    expect(
      resolveOnboardingEmailUpdate({
        bodyEmail: "  Ada@Example.COM ",
        sessionEmail: "ada@example.com",
        isPrivileged: false,
      }),
    ).toEqual({ ok: true });
  });

  it("rejects a self-service write moving the row to a new address", () => {
    const result = resolveOnboardingEmailUpdate({
      bodyEmail: "attacker@example.com",
      sessionEmail: "ada@example.com",
      isPrivileged: false,
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
          isPrivileged: false,
        }),
      ).toEqual({ ok: true });
    }
  });

  it("lets privileged operators write any address by design", () => {
    expect(
      resolveOnboardingEmailUpdate({
        bodyEmail: "someone-else@example.com",
        sessionEmail: "admin@example.com",
        isPrivileged: true,
      }),
    ).toEqual({ ok: true });
  });
});

describe("canUploadVerificationDoc", () => {
  it("normal mode requires a consultant profile", () => {
    expect(
      canUploadVerificationDoc({
        isOnboardingMode: false,
        hasConsultantProfile: true,
        draftRole: null,
      }),
    ).toBe(true);
    expect(
      canUploadVerificationDoc({
        isOnboardingMode: false,
        hasConsultantProfile: false,
        draftRole: "CONSULTANT",
      }),
    ).toBe(false);
  });

  it("onboarding mode with a profile is always allowed", () => {
    expect(
      canUploadVerificationDoc({
        isOnboardingMode: true,
        hasConsultantProfile: true,
        draftRole: null,
      }),
    ).toBe(true);
  });

  it("transient onboarding uploads require a CONSULTANT draft", () => {
    expect(
      canUploadVerificationDoc({
        isOnboardingMode: true,
        hasConsultantProfile: false,
        draftRole: "CONSULTANT",
      }),
    ).toBe(true);
    for (const draftRole of [null, undefined, "CONSULTEE", "ORG_WORKSPACE"]) {
      expect(
        canUploadVerificationDoc({
          isOnboardingMode: true,
          hasConsultantProfile: false,
          draftRole,
        }),
      ).toBe(false);
    }
  });
});

describe("DEGRADED write-block for the onboarding wizard route", () => {
  it("blocks server-action POSTs to /form/onboarding", () => {
    expect(isWriteBlockedInDegraded("/form/onboarding", "POST")).toBe(true);
  });

  it("leaves GET reads open (banner-only degraded mode)", () => {
    expect(isWriteBlockedInDegraded("/form/onboarding", "GET")).toBe(false);
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
    expect(VerificationSubmitSchema.safeParse({ nope: 1 }).success).toBe(
      false,
    );
  });
});
