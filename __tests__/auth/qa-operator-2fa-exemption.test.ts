import {
  isQaOperatorEmail,
  isQaOperatorExemptFrom2fa,
  needsOperatorTwoFactor,
} from "@/lib/auth/qa-accounts";

const qaAdmin = { role: "ADMIN", email: "qa-admin-2@qa.familiarise.invalid" };
const qaStaff = { role: "STAFF", email: " QA-Staff-1@QA.familiarise.invalid " };
const realAdmin = { role: "ADMIN", email: "founder@familiarisenow.com" };
const env = (sentryEnvironment: string | undefined) => ({ sentryEnvironment });

describe("isQaOperatorExemptFrom2fa", () => {
  it.each([
    ["prod + QA account", qaAdmin, env("production"), false],
    ["preview + real admin", realAdmin, env("preview"), false],
    ["preview + QA account", qaAdmin, env("preview"), true],
    [
      "local dev + QA staff (case and spaces ignored)",
      qaStaff,
      env("development"),
      true,
    ],
    ["missing env + QA account", qaAdmin, env(undefined), false],
    ["empty env + QA account", qaAdmin, env(""), false],
    ["unrecognised env + QA account", qaAdmin, env("Production"), false],
    ["test env + QA account", qaAdmin, env("test"), false],
    [
      "QA email on a consumer role",
      { ...qaAdmin, role: "CONSULTEE" },
      env("preview"),
      false,
    ],
    ["no email", { role: "ADMIN", email: null }, env("preview"), false],
  ])("%s", (_label, user, deploy, expected) => {
    expect(isQaOperatorExemptFrom2fa(user, deploy)).toBe(expected);
  });
});

describe("isQaOperatorEmail", () => {
  it.each([
    [
      "listed address on the reserved domain",
      "qa-staff-4@qa.familiarise.invalid",
      true,
    ],
    [
      "enrolled QA operator, not listed",
      "qa-admin-1@qa.familiarise.invalid",
      false,
    ],
    ["old public-mailbox seed address", "patrick.brown@gmail.com", false],
    ["listed local part on another domain", "qa-admin-2@gmail.com", false],
    ["look-alike suffix", "qa-admin-2@qa.familiarise.invalid.evil.io", false],
  ])("%s", (_label, email, expected) => {
    expect(isQaOperatorEmail(email)).toBe(expected);
  });
});

describe("needsOperatorTwoFactor", () => {
  it("keeps every unenrolled operator gated except an exempt QA account", () => {
    expect(needsOperatorTwoFactor(realAdmin, env("preview"))).toBe(true);
    expect(needsOperatorTwoFactor(qaAdmin, env("production"))).toBe(true);
    expect(needsOperatorTwoFactor(qaAdmin, env("preview"))).toBe(false);
    expect(
      needsOperatorTwoFactor(
        { ...realAdmin, twoFactorEnabled: true },
        env("production"),
      ),
    ).toBe(false);
    expect(needsOperatorTwoFactor({ role: "CONSULTANT" }, env(undefined))).toBe(
      false,
    );
  });
});
