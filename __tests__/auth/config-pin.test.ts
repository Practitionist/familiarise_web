/**
 * @jest-environment node
 */

/**
 * Pins the security-critical parts of the exported BetterAuth config, so a
 * refactor or an upstream default cannot loosen them unnoticed.
 */

jest.mock("../../lib/prisma", () => ({ __esModule: true, default: {} }));
jest.mock("../../lib/email", () => ({}));
jest.mock("../../lib/novu/subscriber", () => ({ syncSubscriber: jest.fn() }));
jest.mock("../../lib/rate-limit", () => ({
  existingAccountNoticeLimiter: { limit: jest.fn() },
}));

import type { BetterAuthOptions } from "better-auth";
import { auth } from "../../lib/auth";

const options: BetterAuthOptions = auth.options;

function plugin(id: string) {
  return options.plugins?.find((p) => p.id === id);
}

describe("lib/auth.ts config pin", () => {
  it("requires a verified email before any credential session", () => {
    expect(options.emailAndPassword?.requireEmailVerification).toBe(true);
    expect(options.emailVerification?.sendOnSignUp).toBe(true);
    expect(options.emailVerification?.sendOnSignIn).toBe(true);
  });

  it("verifies with the email OTP plugin, not a link", () => {
    expect(options.emailVerification?.sendVerificationEmail).toBeUndefined();
    const otp = plugin("email-otp") as
      { options?: Record<string, unknown> } | undefined;
    expect(otp?.options).toMatchObject({
      overrideDefaultEmailVerification: true,
      otpLength: 6,
      storeOTP: "hashed",
    });
    expect(Number(otp?.options?.allowedAttempts)).toBeLessThanOrEqual(5);
    expect(Number(otp?.options?.expiresIn)).toBeLessThanOrEqual(15 * 60);
  });

  it("caps passwords at bcrypt's 72 bytes and ends every session on reset", () => {
    expect(options.emailAndPassword?.maxPasswordLength).toBe(72);
    expect(options.emailAndPassword?.revokeSessionsOnPasswordReset).toBe(true);
    expect(options.emailAndPassword?.onPasswordReset).toBeInstanceOf(Function);
    expect(options.emailAndPassword?.onExistingUserSignUp).toBeInstanceOf(
      Function,
    );
  });

  it("never links on a provider's email claim alone", () => {
    expect(options.account?.accountLinking?.trustedProviders).toBeUndefined();
    expect(options.account?.encryptOAuthTokens).toBe(true);
  });

  it("reads every session from the database", () => {
    expect(options.session?.cookieCache?.enabled).toBe(false);
  });

  it("stores verification identifiers hashed and sends mail in the background", () => {
    expect(options.verification?.storeIdentifier).toBe("hashed");
    expect(options.advanced?.backgroundTasks?.handler).toBeInstanceOf(Function);
    expect(options.advanced?.useSecureCookies).toBe(true);
  });

  it.each([
    "/list-sessions",
    "/revoke-session",
    "/revoke-sessions",
    "/revoke-other-sessions",
    "/two-factor/get-totp-uri",
    "/verify-email",
    "/send-verification-email",
    "/sign-in/email-otp",
    "/email-otp/check-verification-otp",
    "/email-otp/request-password-reset",
    "/forget-password/email-otp",
    "/email-otp/reset-password",
    "/email-otp/request-email-change",
    "/email-otp/change-email",
  ])("keeps %s unmounted", (path) => {
    expect(options.disabledPaths).toContain(path);
  });

  it("registers the policy plugins", () => {
    for (const id of [
      "breached-password-check",
      "core-auth-policy",
      "account-lifecycle",
    ]) {
      expect(plugin(id)).toBeDefined();
    }
  });

  it("registers no social provider without credentials", () => {
    for (const config of Object.values(options.socialProviders ?? {})) {
      if (typeof config === "function") throw new Error("lazy provider config");
      expect(config?.clientId).toBeTruthy();
    }
  });
});
