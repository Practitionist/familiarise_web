import {
  isQaOperatorExemptFrom2fa,
  needsOperatorTwoFactor,
} from "@/lib/auth/qa-accounts";

const qaAdmin = { role: "ADMIN", email: "patrick.brown@gmail.com" };
const qaStaff = { role: "STAFF", email: " Maria.Brown@Gmail.com " };
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
    [
      "look-alike address",
      { role: "ADMIN", email: "patrick.brown@gmail.com.evil.io" },
      env("preview"),
      false,
    ],
  ])("%s", (_label, user, deploy, expected) => {
    expect(isQaOperatorExemptFrom2fa(user, deploy)).toBe(expected);
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
