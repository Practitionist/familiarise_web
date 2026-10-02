/**
 * Single-source authentication error catalog and humanizer.
 *
 * Maps Better Auth and app-minted error codes to customer-facing copy without
 * ever echoing raw server/library error strings (`error.message`).
 */

import type { auth } from "@/lib/auth";

export type BetterAuthErrorCode =
  | "USER_NOT_FOUND"
  | "FAILED_TO_UPDATE_USER"
  | "INVALID_PASSWORD"
  | "INVALID_EMAIL"
  | "INVALID_EMAIL_OR_PASSWORD"
  | "PROVIDER_NOT_FOUND"
  | "INVALID_TOKEN"
  | "TOKEN_EXPIRED"
  | "EMAIL_NOT_VERIFIED"
  | "PASSWORD_TOO_SHORT"
  | "PASSWORD_TOO_LONG"
  | "USER_ALREADY_EXISTS"
  | "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL"
  | "CREDENTIAL_ACCOUNT_NOT_FOUND"
  | "SESSION_EXPIRED"
  | "FAILED_TO_UNLINK_LAST_ACCOUNT"
  | "ACCOUNT_NOT_FOUND"
  | "EMAIL_ALREADY_VERIFIED"
  | "SESSION_NOT_FRESH"
  | "INVALID_ORIGIN"
  | "VALIDATION_ERROR"
  | "PASSWORD_ALREADY_SET"
  | "BANNED_USER"
  | "INVALID_CODE"
  | "INVALID_BACKUP_CODE"
  | "INVALID_TWO_FACTOR_COOKIE"
  | "ACCOUNT_TEMPORARILY_LOCKED"
  | "PASSWORD_COMPROMISED";

type InstalledBetterAuthErrorCode = keyof typeof auth.$ERROR_CODES & string;
type AssertNoneMissing<T extends never> = T;
export type StaleBetterAuthErrorCode = AssertNoneMissing<
  Exclude<BetterAuthErrorCode, InstalledBetterAuthErrorCode>
>;

export type AppAuthErrorCode =
  | "SSO_REQUIRED"
  | "SSO_PROVIDER_MISCONFIGURED"
  | "SSO_EMAIL_DOMAIN_MISMATCH"
  | "RATE_LIMITED"
  | "SESSION_LOOKUP_FAILED"
  | "REQUEST_REJECTED"
  | "TWO_FACTOR_REQUIRED"
  | "STAFF_PASSWORD_SIGN_IN_ONLY"
  | "TRUST_DEVICE_DISABLED"
  | "INVITATION_NOT_FOUND"
  | "INVITATION_EXPIRED"
  | "INVITATION_ALREADY_ACCEPTED"
  | "INVITATION_NOT_FOR_YOU";

export type AuthErrorCode = BetterAuthErrorCode | AppAuthErrorCode;

export const AUTH_ERROR_CODES = {
  USER_NOT_FOUND: "USER_NOT_FOUND",
  FAILED_TO_UPDATE_USER: "FAILED_TO_UPDATE_USER",
  INVALID_PASSWORD: "INVALID_PASSWORD",
  INVALID_EMAIL: "INVALID_EMAIL",
  INVALID_EMAIL_OR_PASSWORD: "INVALID_EMAIL_OR_PASSWORD",
  PROVIDER_NOT_FOUND: "PROVIDER_NOT_FOUND",
  INVALID_TOKEN: "INVALID_TOKEN",
  TOKEN_EXPIRED: "TOKEN_EXPIRED",
  EMAIL_NOT_VERIFIED: "EMAIL_NOT_VERIFIED",
  PASSWORD_TOO_SHORT: "PASSWORD_TOO_SHORT",
  PASSWORD_TOO_LONG: "PASSWORD_TOO_LONG",
  USER_ALREADY_EXISTS: "USER_ALREADY_EXISTS",
  USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL:
    "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL",
  CREDENTIAL_ACCOUNT_NOT_FOUND: "CREDENTIAL_ACCOUNT_NOT_FOUND",
  SESSION_EXPIRED: "SESSION_EXPIRED",
  FAILED_TO_UNLINK_LAST_ACCOUNT: "FAILED_TO_UNLINK_LAST_ACCOUNT",
  ACCOUNT_NOT_FOUND: "ACCOUNT_NOT_FOUND",
  EMAIL_ALREADY_VERIFIED: "EMAIL_ALREADY_VERIFIED",
  SESSION_NOT_FRESH: "SESSION_NOT_FRESH",
  INVALID_ORIGIN: "INVALID_ORIGIN",
  VALIDATION_ERROR: "VALIDATION_ERROR",
  PASSWORD_ALREADY_SET: "PASSWORD_ALREADY_SET",
  BANNED_USER: "BANNED_USER",
  INVALID_CODE: "INVALID_CODE",
  INVALID_BACKUP_CODE: "INVALID_BACKUP_CODE",
  INVALID_TWO_FACTOR_COOKIE: "INVALID_TWO_FACTOR_COOKIE",
  ACCOUNT_TEMPORARILY_LOCKED: "ACCOUNT_TEMPORARILY_LOCKED",
  PASSWORD_COMPROMISED: "PASSWORD_COMPROMISED",
  SSO_REQUIRED: "SSO_REQUIRED",
  SSO_PROVIDER_MISCONFIGURED: "SSO_PROVIDER_MISCONFIGURED",
  SSO_EMAIL_DOMAIN_MISMATCH: "SSO_EMAIL_DOMAIN_MISMATCH",
  RATE_LIMITED: "RATE_LIMITED",
  SESSION_LOOKUP_FAILED: "SESSION_LOOKUP_FAILED",
  REQUEST_REJECTED: "REQUEST_REJECTED",
  TWO_FACTOR_REQUIRED: "TWO_FACTOR_REQUIRED",
  STAFF_PASSWORD_SIGN_IN_ONLY: "STAFF_PASSWORD_SIGN_IN_ONLY",
  TRUST_DEVICE_DISABLED: "TRUST_DEVICE_DISABLED",
  INVITATION_NOT_FOUND: "INVITATION_NOT_FOUND",
  INVITATION_EXPIRED: "INVITATION_EXPIRED",
  INVITATION_ALREADY_ACCEPTED: "INVITATION_ALREADY_ACCEPTED",
  INVITATION_NOT_FOR_YOU: "INVITATION_NOT_FOR_YOU",
} as const satisfies Record<AuthErrorCode, AuthErrorCode>;

const KNOWN_CODES: ReadonlySet<string> = new Set(
  Object.values(AUTH_ERROR_CODES),
);

export function isAuthErrorCode(value: unknown): value is AuthErrorCode {
  return typeof value === "string" && KNOWN_CODES.has(value.toUpperCase());
}

export function normalizeAuthErrorCode(
  value: string | null | undefined,
): AuthErrorCode | null {
  if (!value) return null;
  const upper = value.trim().toUpperCase();
  return KNOWN_CODES.has(upper) ? (upper as AuthErrorCode) : null;
}

export type AuthErrorField =
  | "email"
  | "password"
  | "newPassword"
  | "referral"
  | "code";

export type AuthErrorAction =
  | "forgot-password"
  | "resend-verification"
  | "request-new-link"
  | "switch-to-sso"
  | "sign-in"
  | "sign-up"
  | "retry"
  | "contact-support"
  | "enroll-2fa";

export interface AuthErrorCopy {
  title: string;
  description: string;
  field?: AuthErrorField;
  needsVerification?: boolean;
  action?: AuthErrorAction;
}

export type AuthFlowName = "signin" | "signup" | "forgot" | "reset" | "verify";
export type { AuthFlowName as AuthFlow };

const SUPPORT = "support@familiarisenow.com";

export const UNREACHABLE: AuthErrorCopy = {
  title: "We couldn't reach the sign-in service",
  description: "Nothing was changed. Please try again in a moment.",
  action: "retry",
};

export const AUTH_ERROR_COPY = {
  INVALID_EMAIL_OR_PASSWORD: {
    title: "That email and password don't match",
    description: "Check both and try again, or use Forgot password?",
    field: "password",
    action: "forgot-password",
  },
  INVALID_PASSWORD: {
    title: "That password didn't work",
    description: "Check for a capital letter or a typo, then try again.",
    field: "password",
    action: "forgot-password",
  },
  CREDENTIAL_ACCOUNT_NOT_FOUND: {
    title: "This account has no password",
    description:
      "You signed up with Google or GitHub, or through your organisation's SSO. Use that button instead.",
  },
  USER_NOT_FOUND: {
    title: "We couldn't find that account",
    description: "It may have been deleted. Sign up again to start over.",
    action: "sign-up",
  },
  EMAIL_NOT_VERIFIED: {
    title: "Verify your email first",
    description: "Your email isn't verified yet — resend the link below.",
    needsVerification: true,
    action: "resend-verification",
  },
  BANNED_USER: {
    title: "This account is suspended",
    description: `Contact ${SUPPORT} if you think this is a mistake.`,
    action: "contact-support",
  },
  SESSION_EXPIRED: {
    title: "Your session has expired",
    description: "For your security, sign in again to continue.",
    action: "sign-in",
  },
  SESSION_NOT_FRESH: {
    title: "Please sign in again",
    description:
      "This is a sensitive action, so we ask you to confirm it's you.",
    action: "sign-in",
  },
  SESSION_LOOKUP_FAILED: UNREACHABLE,
  USER_ALREADY_EXISTS: {
    title: "This email already has an account",
    description: "Sign in instead, or reset your password if you forgot it.",
    field: "email",
    action: "sign-in",
  },
  USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: {
    title: "This email already has an account",
    description: "Sign in instead, or reset your password if you forgot it.",
    field: "email",
    action: "sign-in",
  },
  PASSWORD_ALREADY_SET: {
    title: "This account already has a password",
    description: "Sign in instead of creating a new account.",
    field: "email",
    action: "sign-in",
  },
  FAILED_TO_UPDATE_USER: {
    title: "We couldn't save that change",
    description: "Nothing was changed. Please try again.",
    action: "retry",
  },
  INVALID_EMAIL: {
    title: "Check the email address",
    description: "Enter a valid email address.",
    field: "email",
  },
  PASSWORD_TOO_SHORT: {
    title: "Password too short",
    description: "Use at least 8 characters.",
    field: "password",
  },
  PASSWORD_TOO_LONG: {
    title: "Password too long",
    description: "Use at most 128 characters.",
    field: "password",
  },
  PASSWORD_COMPROMISED: {
    title: "Choose a different password",
    description:
      "This password has appeared in a data breach, so attackers try it first. Pick one you don't use anywhere else.",
    field: "password",
  },
  INVALID_TOKEN: {
    title: "This link no longer works",
    description: "It is invalid or has already been used. Request a new one.",
    action: "request-new-link",
  },
  TOKEN_EXPIRED: {
    title: "This link has expired",
    description: "Request a new one — links are single-use and time-limited.",
    action: "request-new-link",
  },
  EMAIL_ALREADY_VERIFIED: {
    title: "Already verified",
    description: "This email is verified — you can sign in.",
    action: "sign-in",
  },
  FAILED_TO_UNLINK_LAST_ACCOUNT: {
    title: "You need one way to sign in",
    description:
      "Add a password or another provider before disconnecting this one.",
  },
  ACCOUNT_NOT_FOUND: {
    title: "We couldn't find that connection",
    description: "Refresh the page and try again.",
    action: "retry",
  },
  PROVIDER_NOT_FOUND: {
    title: "That sign-in method isn't available",
    description: "Use your email and password instead.",
    action: "sign-in",
  },
  INVITATION_NOT_FOUND: {
    title: "This invitation link isn't valid",
    description:
      "It may have been revoked. Ask whoever invited you for a new one.",
    action: "contact-support",
  },
  INVITATION_EXPIRED: {
    title: "This invitation has expired",
    description: "Ask for a new one — invitations last 14 days.",
    action: "contact-support",
  },
  INVITATION_ALREADY_ACCEPTED: {
    title: "This invitation was already accepted",
    description: "Open the organisation from your dashboard to get started.",
    action: "retry",
  },
  INVITATION_NOT_FOR_YOU: {
    title: "This invitation isn't for you",
    description: "It was sent to a different email address.",
    action: "contact-support",
  },
  SSO_REQUIRED: {
    title: "Use your organisation's sign-in",
    description:
      "Your organisation requires its own sign-in for this email, so password and Google sign-in are turned off. Use the SSO button below.",
    field: "email",
    action: "switch-to-sso",
  },
  SSO_PROVIDER_MISCONFIGURED: {
    title: "Your organisation's sign-in is not set up yet",
    description: `Ask an administrator to finish the SSO setup, or contact ${SUPPORT}.`,
    action: "contact-support",
  },
  SSO_EMAIL_DOMAIN_MISMATCH: {
    title: "This email isn't on your organisation's domain",
    description: `Sign in another way, or ask your administrator to check the SSO setup. Still stuck? Contact ${SUPPORT}.`,
    action: "contact-support",
  },
  RATE_LIMITED: {
    title: "Too many attempts",
    description: "Please wait a moment, then try again.",
    action: "retry",
  },
  TWO_FACTOR_REQUIRED: {
    title: "Set up two-factor authentication",
    description: "Staff accounts need a second factor before you can continue.",
    action: "enroll-2fa",
  },
  STAFF_PASSWORD_SIGN_IN_ONLY: {
    title: "Sign in with your password",
    description:
      "Staff accounts sign in with email, password and an authenticator code.",
  },
  TRUST_DEVICE_DISABLED: {
    title: "Trusted devices aren't available",
    description:
      "Enter a code from your authenticator app each time you sign in.",
  },
  INVALID_CODE: {
    title: "That code isn't right",
    description: "Check the code and try again.",
    field: "code",
  },
  INVALID_BACKUP_CODE: {
    title: "That backup code isn't right",
    description:
      "Each backup code works once. Try another, or generate new ones.",
    field: "code",
  },
  INVALID_TWO_FACTOR_COOKIE: {
    title: "Your verification expired",
    description: "Sign in again to start a new one.",
    action: "sign-in",
  },
  ACCOUNT_TEMPORARILY_LOCKED: {
    title: "Too many wrong codes",
    description:
      "For your security, two-factor sign-in is paused. Wait 15 minutes, then try again.",
    field: "code",
    action: "retry",
  },
  REQUEST_REJECTED: {
    title: "This sign-in request was blocked",
    description:
      "Our security policy stopped the request before it reached the sign-in service. If you're on a preview deployment, use the main site's address instead.",
    action: "retry",
  },
  INVALID_ORIGIN: {
    title: "This sign-in request was blocked",
    description: "The address this page was opened from isn't recognised.",
    action: "retry",
  },
  VALIDATION_ERROR: {
    title: "Check the form",
    description: "One of the fields needs fixing.",
  },
} as const satisfies Record<AuthErrorCode, AuthErrorCopy>;

export const AUTH_ERROR_COPY_BY_FLOW: Readonly<
  Partial<
    Record<AuthFlowName, Readonly<Record<string, Partial<AuthErrorCopy>>>>
  >
> = {
  reset: {
    INVALID_TOKEN: {
      title: "This reset link no longer works",
      description:
        "Reset links last 30 minutes and work once. Request a new one.",
      action: "request-new-link" as const,
    },
    TOKEN_EXPIRED: {
      title: "This reset link has expired",
      description: "Reset links last 30 minutes. Request a new one.",
      action: "request-new-link" as const,
    },
    PASSWORD_COMPROMISED: { field: "newPassword" as const },
  },
  verify: {
    INVALID_TOKEN: {
      title: "This verification link no longer works",
      description:
        "Verification links last 1 hour and work once. Request a fresh one.",
      action: "resend-verification" as const,
    },
    TOKEN_EXPIRED: {
      title: "This verification link has expired",
      description: "Verification links last 1 hour. Request a fresh one below.",
      action: "resend-verification" as const,
    },
  },
  forgot: {},
};

export interface AuthClientError {
  message?: string | null;
  code?: string | null;
  status?: number | null;
  retryAfterSeconds?: number | null;
}

export interface HumanizeOptions {
  retryAfterSeconds?: number | null;
}

export function formatRetryAfter(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "a moment";
  if (seconds < 60) {
    const s = Math.ceil(seconds);
    return s === 1 ? "1 second" : `${s} seconds`;
  }
  if (seconds < 3600) {
    const m = Math.ceil(seconds / 60);
    return m === 1 ? "1 minute" : `${m} minutes`;
  }
  if (seconds < 86400) {
    const h = Math.ceil(seconds / 3600);
    return h === 1 ? "1 hour" : `${h} hours`;
  }
  const d = Math.ceil(seconds / 86400);
  return d === 1 ? "1 day" : `${d} days`;
}

function withRetryAfter(
  base: AuthErrorCopy,
  retryAfterSeconds: number | null | undefined,
): AuthErrorCopy {
  if (!retryAfterSeconds || retryAfterSeconds <= 0) return base;
  const wait = formatRetryAfter(retryAfterSeconds);
  return {
    ...base,
    description: `For your security, please wait ${wait} before trying again.`,
  };
}

function copyForStatus(
  flow: AuthFlowName,
  status: number | null | undefined,
  retryAfterSeconds: number | null | undefined,
): AuthErrorCopy {
  if (status === 429) {
    return withRetryAfter(AUTH_ERROR_COPY.RATE_LIMITED, retryAfterSeconds);
  }
  if (status === 401 || status === 403) {
    return AUTH_ERROR_COPY.REQUEST_REJECTED;
  }
  if (status === 0 || (typeof status === "number" && status >= 500)) {
    return UNREACHABLE;
  }
  switch (flow) {
    case "signin":
      return {
        title: "Couldn't sign you in",
        description: "Check the details you entered and try again.",
        action: "retry",
      };
    case "signup":
      return {
        title: "Couldn't create your account",
        description: "Check the details you entered and try again.",
        action: "retry",
      };
    case "forgot":
      return {
        title: "Couldn't send the reset link",
        description: "Check the email address and try again.",
        action: "retry",
      };
    case "reset":
      return {
        title: "Couldn't update your password",
        description:
          "The reset link may have expired. Request a new one and try again.",
        action: "request-new-link",
      };
    case "verify":
      return {
        title: "Couldn't verify your email",
        description:
          "The link may have expired. Request a fresh one and try again.",
        action: "resend-verification",
      };
  }
}

function fieldFromValidationMessage(
  flow: AuthFlowName,
  message: string | null | undefined,
): Partial<AuthErrorCopy> | null {
  if (!message) return null;
  if (message.includes("[body.email]")) {
    return AUTH_ERROR_COPY.INVALID_EMAIL;
  }
  if (
    message.includes("[body.password]") ||
    message.includes("[body.newPassword]")
  ) {
    const field: AuthErrorField =
      flow === "reset" && message.includes("[body.newPassword]")
        ? "newPassword"
        : "password";
    if (message.includes("Too small")) {
      return { ...AUTH_ERROR_COPY.PASSWORD_TOO_SHORT, field };
    }
    if (message.includes("Too big")) {
      return { ...AUTH_ERROR_COPY.PASSWORD_TOO_LONG, field };
    }
    return {
      title: "Check the password",
      description: "Use 8 to 128 characters.",
      field,
    };
  }
  return null;
}

function extractError(error: unknown): AuthClientError {
  if (!error || typeof error !== "object") return {};
  const e = error as {
    code?: unknown;
    status?: unknown;
    message?: unknown;
    retryAfterSeconds?: unknown;
  };
  return {
    code: typeof e.code === "string" ? e.code : null,
    status: typeof e.status === "number" ? e.status : null,
    message: typeof e.message === "string" ? e.message : null,
    retryAfterSeconds:
      typeof e.retryAfterSeconds === "number" ? e.retryAfterSeconds : null,
  };
}

export function humanizeAuthError(
  flow: AuthFlowName,
  error: unknown,
  options?: HumanizeOptions,
): AuthErrorCopy {
  const { code: rawCode, status, message, retryAfterSeconds } =
    extractError(error);
  const wait = options?.retryAfterSeconds ?? retryAfterSeconds;

  const code = normalizeAuthErrorCode(rawCode);
  if (code) {
    if (code === "VALIDATION_ERROR") {
      const fromField = fieldFromValidationMessage(flow, message);
      if (fromField?.title && fromField.description) {
        return fromField as AuthErrorCopy;
      }
    }
    const base = (AUTH_ERROR_COPY as Record<string, AuthErrorCopy>)[code];
    if (base) {
      const override = AUTH_ERROR_COPY_BY_FLOW[flow]?.[code];
      const merged: AuthErrorCopy = override ? { ...base, ...override } : base;
      if (code === "RATE_LIMITED" || status === 429) {
        return withRetryAfter(merged, wait);
      }
      return merged;
    }
  }

  return copyForStatus(flow, status, wait);
}
