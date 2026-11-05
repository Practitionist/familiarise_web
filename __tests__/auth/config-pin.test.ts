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
jest.mock("@sentry/nextjs", () => {
  const actual = jest.requireActual("@sentry/nextjs");
  return {
    ...actual,
    captureMessage: jest.fn(),
    captureException: jest.fn(),
    logger: { ...actual.logger, warn: jest.fn() },
  };
});

import * as Sentry from "@sentry/nextjs";
import type { BetterAuthOptions } from "better-auth";
import { auth } from "../../lib/auth";
import {
  CAPTCHA_PROTECTED_PATHS,
  TURNSTILE_ALWAYS_FAIL_SECRET,
  turnstileCaptcha,
  turnstileHostnames,
} from "../../lib/auth/captcha";

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
      "account-sign-in-throttle",
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

  it("puts Turnstile on the mail-sending endpoints only, and only with both keys", () => {
    expect(CAPTCHA_PROTECTED_PATHS).toEqual([
      "/sign-up/email",
      "/request-password-reset",
      "/email-otp/send-verification-otp",
    ]);
    const [captcha] = turnstileCaptcha({
      secretKey: "1x0000000000000000000000000000000AA",
      siteKey: "1x00000000000000000000AA",
    });
    expect(captcha?.options).toMatchObject({
      provider: "cloudflare-turnstile",
      endpoints: CAPTCHA_PROTECTED_PATHS,
    });
    expect(
      turnstileCaptcha({
        secretKey: "1x0000000000000000000000000000000AA",
        siteKey: undefined,
      }),
    ).toEqual([]);
    expect(
      turnstileHostnames({
        sentryEnvironment: "production",
        authUrl: "https://familiarisenow.com",
      }),
    ).toEqual(["familiarisenow.com"]);
    expect(
      turnstileHostnames({
        sentryEnvironment: "preview",
        authUrl: "https://familiarisenow.com",
      }),
    ).toBeUndefined();
  });

  it("boots a production runtime without keys with a log line, never a Sentry issue", () => {
    const nodeEnv = process.env.NODE_ENV;
    const error = jest.spyOn(console, "error").mockImplementation(() => {});
    Object.defineProperty(process.env, "NODE_ENV", {
      value: "production",
      configurable: true,
      writable: true,
    });
    try {
      expect(
        turnstileCaptcha({ secretKey: undefined, siteKey: undefined }),
      ).toEqual([]);
    } finally {
      Object.defineProperty(process.env, "NODE_ENV", {
        value: nodeEnv,
        configurable: true,
        writable: true,
      });
      error.mockRestore();
    }
    expect(Sentry.logger.warn).toHaveBeenCalledWith("AUTH_CAPTCHA_DISABLED", {
      missing: "TURNSTILE_SECRET_KEY,NEXT_PUBLIC_TURNSTILE_SITE_KEY",
    });
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it("verifies with the always-fail secret when production holds a test key", () => {
    const error = jest.spyOn(console, "error").mockImplementation(() => {});
    const verifiesWith = (
      secretKey: string,
      siteKey: string,
      sentryEnvironment: string,
      expected: string,
    ) =>
      expect(
        turnstileCaptcha({ secretKey, siteKey, sentryEnvironment })[0]?.options,
      ).toMatchObject({ secretKey: expected });
    const passSecret = "1x0000000000000000000000000000000AA";
    const passSite = "1x00000000000000000000AA";
    try {
      verifiesWith(
        "real-secret",
        passSite,
        "production",
        TURNSTILE_ALWAYS_FAIL_SECRET,
      );
      verifiesWith(
        passSecret,
        "real-site",
        "production",
        TURNSTILE_ALWAYS_FAIL_SECRET,
      );
      verifiesWith(passSecret, passSite, "preview", passSecret);
      verifiesWith("real-secret", "real-site", "production", "real-secret");
    } finally {
      error.mockRestore();
    }
    expect(Sentry.logger.warn).toHaveBeenCalledWith(
      "AUTH_CAPTCHA_TEST_KEYS_IN_PRODUCTION",
      { keys: "NEXT_PUBLIC_TURNSTILE_SITE_KEY" },
    );
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });
});
