/**
 * Every code the OAuth/SSO callbacks redirect with, and every code the auth
 * hardening streams mint, has its own catalog copy rather than the flow's
 * generic fallback (which used to leave the sign-in page blank).
 */

import {
  AUTH_ERROR_COPY,
  humanizeAuthError,
} from "../../lib/labels/auth-errors";

// The lowercase `?error=` values BetterAuth and @better-auth/sso 1.7.7 use.
const CALLBACK_CODES = [
  "account_not_linked",
  "unable_to_link_account",
  "account_already_linked_to_different_user",
  "account_ownership_conflict",
  "email_does_not_match",
  "email_not_found",
  "email_not_verified",
  "access_denied",
  "state_mismatch",
  "state_not_found",
  "invalid_state",
  "please_restart_the_process",
  "invalid_callback_request",
  "no_code",
  "unable_to_get_user_info",
  "oauth_provider_not_found",
  "issuer_mismatch",
  "invalid_provider",
  "token_not_verified",
  "unable_to_create_user",
  "unable_to_create_session",
  "signup_disabled",
  "internal_server_error",
];

const MINTED_CODES = [
  "NAME_INVALID",
  "FAILED_TO_CREATE_USER",
  "INVALID_OTP",
  "OTP_EXPIRED",
  "TOO_MANY_ATTEMPTS",
  "PASSWORD_TOO_LONG",
  "SSO_NOT_PROVEN",
  "IDENTITY_CHANGED",
  "REAUTH_REQUIRED",
  "TWO_FACTOR_REQUIRED",
  "TWO_FACTOR_OPERATORS_ONLY",
  "SELF_RESET_FORBIDDEN",
  "ALREADY_ONBOARDED",
];

describe("callback and minted error codes", () => {
  it.each([...CALLBACK_CODES, ...MINTED_CODES])(
    "%s has its own copy",
    (code) => {
      const key = code.toUpperCase() as keyof typeof AUTH_ERROR_COPY;
      expect(AUTH_ERROR_COPY[key]).toBeDefined();
      const copy = humanizeAuthError("signin", { code });
      expect(copy).toEqual(expect.objectContaining(AUTH_ERROR_COPY[key]));
    },
  );

  it("routes an unverified-account link conflict to a password reset", () => {
    expect(
      humanizeAuthError("signin", { code: "account_not_linked" }),
    ).toMatchObject({ action: "forgot-password" });
  });

  it("points wrong and expired verification codes at the code field and a resend", () => {
    expect(humanizeAuthError("verify", { code: "INVALID_OTP" })).toMatchObject({
      field: "code",
    });
    expect(humanizeAuthError("verify", { code: "OTP_EXPIRED" })).toMatchObject({
      action: "resend-verification",
    });
    expect(
      humanizeAuthError("verify", { code: "TOO_MANY_ATTEMPTS" }),
    ).toMatchObject({ action: "resend-verification" });
  });

  it("names the 72-byte limit and the name rules", () => {
    expect(
      humanizeAuthError("signup", { code: "PASSWORD_TOO_LONG" }).description,
    ).toContain("72 bytes");
    expect(humanizeAuthError("signup", { code: "NAME_INVALID" })).toMatchObject(
      { field: "name" },
    );
  });
});
