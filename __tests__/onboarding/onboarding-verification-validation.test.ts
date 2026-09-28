/**
 * @jest-environment node
 *
 * #1869 — the write path validates verification fields.
 *
 * Before this, `verificationLinkedinUrl` was `z.string().optional()` on the
 * server, so a strict client check was the only thing standing between the
 * wizard and a stored identity claim. `verificationDocuments` was
 * `z.array(z.any())` — not insecure, but a schema that claimed to validate
 * nothing it did not.
 */
import {
  normaliseLinkedinProfileUrl,
  linkedinProfileUrlSchema,
  linkedinProfileUrlFormSchema,
  isLinkedinProfileUrl,
  LINKEDIN_PROFILE_URL_RE,
} from "../../schemas/user";
import {
  OnboardingBaseSchema,
  VerificationDocumentRefSchema,
  MAX_VERIFICATION_DOCUMENTS,
} from "../../utils/onboarding";

describe("normaliseLinkedinProfileUrl", () => {
  const accept: Array<[string, string]> = [
    // The canonical form.
    [
      "https://www.linkedin.com/in/realname",
      "https://www.linkedin.com/in/realname",
    ],
    [
      "https://linkedin.com/in/realname",
      "https://www.linkedin.com/in/realname",
    ],
    [
      "http://www.linkedin.com/in/realname",
      "https://www.linkedin.com/in/realname",
    ],
    [
      "https://www.linkedin.com/in/realname/",
      "https://www.linkedin.com/in/realname",
    ],
    // Percent-encoded and non-latin handles are real, and decode on the way in.
    [
      "https://www.linkedin.com/in/jos%C3%A9-garcia",
      "https://www.linkedin.com/in/josé-garcia",
    ],
    // Legacy public-profile routes still resolve for older accounts.
    [
      "https://www.linkedin.com/pub/realname/1/2/3",
      "https://www.linkedin.com/in/realname",
    ],
    [
      "https://www.linkedin.com/public-profile/in/realname",
      "https://www.linkedin.com/in/realname",
    ],
    // Country locale subdomains, then canonicalised.
    [
      "https://in.linkedin.com/in/realname",
      "https://www.linkedin.com/in/realname",
    ],
    [
      "https://uk.linkedin.com/in/realname",
      "https://www.linkedin.com/in/realname",
    ],
    // Tracking params and locale path suffixes must not survive into storage.
    [
      "https://www.linkedin.com/in/realname?trk=people-guest_profile",
      "https://www.linkedin.com/in/realname",
    ],
    [
      "https://www.linkedin.com/in/realname/de",
      "https://www.linkedin.com/in/realname",
    ],
  ];

  it.each(accept)("accepts and canonicalises %s", (input, expected) => {
    const result = normaliseLinkedinProfileUrl(input);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.url).toBe(expected);
    }
  });

  const reject = [
    // Not a URL at all — the exact value the old server schema accepted.
    "banana",
    "",
    "   ",
    // Generic URLs: the old form schema accepted these.
    "https://evil.test",
    "https://evil.test/in/realname",
    // SSRF-shaped bypasses. A regex anchored on `^https://www.linkedin.com`
    // is fooled by the first of these; a parsed `hostname` is not.
    "https://www.linkedin.com:secret@evil.test/in/x",
    "https://linkedin.com@evil.test/in/x",
    "https://linkedin.com.evil.test/in/x",
    // Substring confusion, which the old `linkedinUrlSchema` allowed.
    "https://evil.test/?u=https://linkedin.com/in/realname",
    // Right host, wrong path: not a profile.
    "https://www.linkedin.com/company/somecompany",
    "https://www.linkedin.com/feed",
    "https://www.linkedin.com/in/",
    "https://www.linkedin.com/",
    // Non-http scheme.
    "javascript:alert(1)",
    "file:///etc/passwd",
  ];

  it.each(reject)("rejects %s", (input) => {
    expect(normaliseLinkedinProfileUrl(input).ok).toBe(false);
  });

  it("survives a hostile string without throwing", () => {
    for (const nasty of ["http://", "https://[", "https://xn--/", "://"]) {
      expect(() => normaliseLinkedinProfileUrl(nasty)).not.toThrow();
    }
  });
});

describe("linkedinProfileUrlSchema", () => {
  it("produces the canonical form so storage is uniform", () => {
    const parsed = linkedinProfileUrlSchema.parse(
      "  https://uk.linkedin.com/in/Real-Name/?trk=x  ",
    );
    expect(parsed).toBe("https://www.linkedin.com/in/Real-Name");
  });

  it("rejects a non-URL string that the old server schema allowed", () => {
    expect(linkedinProfileUrlSchema.safeParse("banana").success).toBe(false);
  });

  it("rejects a non-LinkedIn URL that the old form schema allowed", () => {
    expect(
      linkedinProfileUrlSchema.safeParse("https://evil.test").success,
    ).toBe(false);
  });

  it("reports a message the user can act on", () => {
    const result = linkedinProfileUrlSchema.safeParse("nope");
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toMatch(/linkedin\.com\/in/i);
    }
  });
});

describe("linkedinProfileUrlFormSchema", () => {
  it("treats an untouched input as absent, not invalid", () => {
    expect(linkedinProfileUrlFormSchema.parse("")).toBeUndefined();
  });

  it("treats an omitted input as absent, not invalid", () => {
    // Regression: replacing `.optional().or(z.literal(""))` with a bare union
    // made every payload that simply omits the field fail with "Required" —
    // which is a consultee, a staff member, and any consultant who has not
    // reached the verification step.
    expect(linkedinProfileUrlFormSchema.parse(undefined)).toBeUndefined();
  });

  it("still validates a value the user did type", () => {
    expect(linkedinProfileUrlFormSchema.safeParse("banana").success).toBe(
      false,
    );
  });
});

describe("the pre-existing client regex", () => {
  // The strict client check was never the bug. It is anchored, and these cases
  // pin that down so a future "simplification" cannot quietly open the hole.
  it("rejects the userinfo and suffix bypasses it was chosen to reject", () => {
    expect(
      isLinkedinProfileUrl("https://www.linkedin.com:secret@evil.test/in/x"),
    ).toBe(false);
    expect(isLinkedinProfileUrl("https://linkedin.com.evil.test/in/x")).toBe(
      false,
    );
    expect(LINKEDIN_PROFILE_URL_RE.test("https://evil.test/in/x")).toBe(false);
  });
});

describe("OnboardingBaseSchema — server boundary", () => {
  const minimal = {
    name: "A",
    email: "a@example.test",
    dateOfBirth: "1990-01-01",
  };

  it("accepts a minimal payload with no LinkedIn and no documents", () => {
    // The common case: a consultee, or a consultant before the last step.
    const result = OnboardingBaseSchema.safeParse(minimal);
    expect(result.success).toBe(true);
  });

  it("refuses a verification LinkedIn URL that is not a URL", () => {
    // The regression this issue exists for.
    const result = OnboardingBaseSchema.safeParse({
      ...minimal,
      verificationLinkedinUrl: "banana",
    });
    expect(result.success).toBe(false);
  });

  it("refuses a verification LinkedIn URL on another host", () => {
    const result = OnboardingBaseSchema.safeParse({
      ...minimal,
      verificationLinkedinUrl: "https://evil.test/in/x",
    });
    expect(result.success).toBe(false);
  });

  it("accepts a locale-subdomain profile and canonicalises it", () => {
    const result = OnboardingBaseSchema.safeParse({
      ...minimal,
      verificationLinkedinUrl: "https://uk.linkedin.com/in/realname",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.verificationLinkedinUrl).toBe(
        "https://www.linkedin.com/in/realname",
      );
    }
  });

  it("caps verification notes server-side, matching the form", () => {
    const long = "x".repeat(501);
    expect(
      OnboardingBaseSchema.safeParse({
        ...minimal,
        verificationNotes: long,
      }).success,
    ).toBe(false);
    expect(
      OnboardingBaseSchema.safeParse({
        ...minimal,
        verificationNotes: "x".repeat(500),
      }).success,
    ).toBe(true);
  });
});

describe("verification documents", () => {
  const doc = { id: "doc_1", fileName: "cert.pdf", fileSize: 1024 };

  it("requires a server-issued id", () => {
    expect(VerificationDocumentRefSchema.safeParse(doc).success).toBe(true);
    expect(
      VerificationDocumentRefSchema.safeParse({ ...doc, id: undefined })
        .success,
    ).toBe(false);
    expect(
      VerificationDocumentRefSchema.safeParse({ fileName: "cert.pdf" }).success,
    ).toBe(false);
  });

  it("rejects non-object entries, which z.array(z.any()) waved through", () => {
    const result = OnboardingBaseSchema.safeParse({
      name: "A",
      email: "a@example.test",
      dateOfBirth: "1990-01-01",
      verificationDocuments: ["not-an-object", 42, null],
    });
    expect(result.success).toBe(false);
  });

  it("caps the array, closing the unbounded payload (ASVS V5.2.4)", () => {
    const base = {
      name: "A",
      email: "a@example.test",
      dateOfBirth: "1990-01-01",
    };
    const many = Array.from(
      { length: MAX_VERIFICATION_DOCUMENTS + 1 },
      (_, i) => ({
        id: `doc_${i}`,
      }),
    );
    expect(
      OnboardingBaseSchema.safeParse({
        ...base,
        verificationDocuments: many,
      }).success,
    ).toBe(false);
    expect(
      OnboardingBaseSchema.safeParse({
        ...base,
        verificationDocuments: many.slice(0, MAX_VERIFICATION_DOCUMENTS),
      }).success,
    ).toBe(true);
  });

  it("rejects a negative file size rather than storing it", () => {
    expect(
      VerificationDocumentRefSchema.safeParse({ ...doc, fileSize: -1 }).success,
    ).toBe(false);
  });
});
