/**
 * Every sentence this app can show about an authentication failure, keyed by
 * `AuthErrorCode` — and by construction complete.
 *
 * The type is `Record<AuthErrorCode, AuthErrorCopy>`, not
 * `Record<string, AuthErrorCopy>`. That is the whole productionisation story of
 * this file: a code that exists but has no entry here is a **compile error**,
 * so it can never reach a customer as "Something went wrong on our side". A
 * Better Auth minor that adds an error code fails the build in CI instead of
 * quietly degrading every one of those paths.
 *
 * ## Why a code is not enough on its own
 *
 * Two of the answers have to vary at runtime for the *same* code:
 *
 *   1. **Flow.** The same `INVALID_TOKEN` means something different on the
 *      password-reset page than on the email-verification page. Per-flow
 *      overrides live in `AUTH_ERROR_COPY_BY_FLOW`, below.
 *
 *   2. **Retry timing.** A 429 is only useful if the customer knows when to come
 *      back. `lib/rate-limit/*` puts `retryAfterSeconds` on the body and
 *      `humanizeAuthError` turns it into a duration.
 *
 * ## i18n
 *
 * This is the translation seam. Every customer-facing string in the product
 * originates here, so wrapping this module in `next-intl`/`useTranslation` is a
 * change to *this file* and the pages that call it — not a hunt through 200
 * components. `description` is a plain string, not JSX, precisely so a message
 * catalogue can extract it. `support@familiarisenow.com` is interpolated rather
 * than typed in so a support-address change is one edit.
 */

import type { AuthErrorCode } from "./auth-error-codes";

export type AuthErrorField = "email" | "password" | "newPassword" | "referral" | "code";

/**
 * What the page should offer next. Deliberately a small closed set: every
 * member maps to a component that already exists or is trivial to add, so a
 * page can never be handed an action it does not know how to render.
 */
export type AuthErrorAction =
  | "forgot-password"
  | "resend-verification"
  | "request-new-link"
  | "switch-to-sso"
  | "sign-in"
  | "sign-up"
  | "retry"
  | "contact-support"
  | "enroll-2fa"
  | "upgrade-plan";

export interface AuthErrorCopy {
  title: string;
  description: string;
  /** The input the sentence belongs under, when there is one. */
  field?: AuthErrorField;
  /** True when the page should switch to its "verify your email" state. */
  needsVerification?: boolean;
  /** The next thing the customer can do about it. */
  action?: AuthErrorAction;
}

const SUPPORT = "support@familiarisenow.com";

/**
 * "We could not reach the service." Used for a thrown fetch (status 0), a 5xx,
 * and the session-lookup tri-state's `failed` case — which is deliberately
 * *not* reported as "signed out" (see `lib/auth-session-lookup.ts`).
 */
export const UNREACHABLE: AuthErrorCopy = {
  title: "We couldn't reach the sign-in service",
  description: "Nothing was changed. Please try again in a moment.",
  action: "retry",
};

/* -------------------------------------------------------------------------- */
/* The catalog                                                               */
/* -------------------------------------------------------------------------- */

export const AUTH_ERROR_COPY = {
  /* ── Sign-in ─────────────────────────────────────────────────────────── */

  INVALID_EMAIL_OR_PASSWORD: {
    // Collapsed. Wrong password, unknown address, and an SSO-only account all
    // arrive here; the provider buttons above the form cover the last one.
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
      "You signed up with Google, GitHub or Facebook, or through your organisation's SSO. Use that button instead.",
  },
  USER_NOT_FOUND: {
    title: "We couldn't find that account",
    description: "It may have been deleted. Sign up again to start over.",
    action: "sign-up",
  },
  INVALID_USER: {
    title: "We couldn't read that account",
    description: "Please try again in a moment.",
    action: "retry",
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
    description: "This is a sensitive action, so we ask you to confirm it's you.",
    action: "sign-in",
  },
  SESSION_LOOKUP_FAILED: UNREACHABLE,

  /* ── Sign-up ─────────────────────────────────────────────────────────── */

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
  USER_ALREADY_HAS_PASSWORD: {
    title: "This account already has a password",
    description: "Sign in instead of creating a new account.",
    field: "email",
    action: "sign-in",
  },
  PASSWORD_ALREADY_SET: {
    title: "This account already has a password",
    description: "Sign in instead of creating a new account.",
    field: "email",
    action: "sign-in",
  },
  FAILED_TO_CREATE_USER: {
    title: "We couldn't create your account",
    description: "Nothing was saved. Please try again in a moment.",
    action: "retry",
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
  EMAIL_CAN_NOT_BE_UPDATED: {
    title: "This email can't be changed",
    description: `Contact ${SUPPORT} to change the address on your account.`,
    action: "contact-support",
  },
  EMAIL_MISMATCH: {
    title: "Different address",
    description: "That address doesn't match the account you're signed in to.",
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
  FAILED_TO_CREATE_SESSION: {
    title: "We couldn't start your session",
    description: "Nothing was changed. Please try again.",
    action: "retry",
  },
  FAILED_TO_GET_SESSION: {
    title: "We couldn't confirm your session",
    description: "Please try again in a moment.",
    action: "retry",
  },

  /* ── Links (reset / verify / onboarding) ─────────────────────────────── */

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
  VERIFICATION_EMAIL_NOT_ENABLED: {
    title: "We can't send that link",
    description: "Email verification isn't switched on for this deployment.",
    action: "contact-support",
  },
  FAILED_TO_CREATE_VERIFICATION: {
    title: "We couldn't create that link",
    description: "Please try again in a moment.",
    action: "retry",
  },
  CALLBACK_URL_REQUIRED: {
    title: "This link is incomplete",
    description: "It looks like part of the address is missing. Request a new one.",
    action: "request-new-link",
  },

  /* ── Linked accounts ─────────────────────────────────────────────────── */

  SOCIAL_ACCOUNT_ALREADY_LINKED: {
    title: "That's already linked",
    description: "Disconnect it first if you want to use a different account.",
    action: "retry",
  },
  LINKED_ACCOUNT_ALREADY_EXISTS: {
    title: "That's already linked",
    description: "This sign-in method is already connected to your account.",
    action: "retry",
  },
  FAILED_TO_UNLINK_LAST_ACCOUNT: {
    title: "You need one way to sign in",
    description: "Add a password or another provider before disconnecting this one.",
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
  ID_TOKEN_NOT_SUPPORTED: {
    title: "That provider isn't supported",
    description: "Use your email and password instead.",
    action: "sign-in",
  },
  FAILED_TO_GET_USER_INFO: {
    title: "We couldn't read your profile",
    description: "The provider didn't send the details we need. Try again.",
    action: "retry",
  },
  USER_EMAIL_NOT_FOUND: {
    title: "The provider didn't send your email",
    description: "Add an email to your provider account, then try again.",
    action: "contact-support",
  },

  /* ── Organisation invitations ────────────────────────────────────────── */

  INVITATION_NOT_FOUND: {
    title: "This invitation link isn't valid",
    description: "It may have been revoked. Ask whoever invited you for a new one.",
    action: "contact-support",
  },
  YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION: {
    title: "This invitation isn't for you",
    description: "It was sent to a different email address. Ask for one for this address.",
    action: "contact-support",
  },
  USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION: {
    title: "You're already on the team",
    description: "No need to accept again — open the organisation from your dashboard.",
    action: "retry",
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
  INVITATION_REVOKED: {
    title: "This invitation was withdrawn",
    description:
      "An administrator withdrew it. Ask them to send a new one if you still need access.",
    action: "contact-support",
  },

  /* ── Staff / admin setup ─────────────────────────────────────────────── */

  SETUP_TOKEN_INVALID: {
    title: "This setup link isn't valid",
    description: "It may have been revoked. Ask an administrator for a new one.",
    action: "contact-support",
  },
  SETUP_TOKEN_EXPIRED: {
    title: "This setup link has expired",
    description: "Setup links last 72 hours. Ask an administrator for a new one.",
    action: "contact-support",
  },
  SETUP_TOKEN_ALREADY_USED: {
    title: "This setup link was already used",
    description: "If that wasn't you, contact support — your account may be at risk.",
    action: "contact-support",
  },

  /* ── Enterprise SSO ──────────────────────────────────────────────────── */

  SSO_REQUIRED: {
    title: "Use your organisation's sign-in",
    description:
      "This email domain signs in through your organisation's SSO. Use the SSO button below.",
    field: "email",
    action: "switch-to-sso",
  },
  SSO_PROVIDER_MISCONFIGURED: {
    title: "Your organisation's sign-in is not set up yet",
    description: `Ask an administrator to finish the SSO setup, or contact ${SUPPORT}.`,
    action: "contact-support",
  },
  SSO_PROVIDER_UNREACHABLE: {
    title: "We couldn't reach your identity provider",
    description:
      "The organisation's sign-in service didn't answer. Wait a minute and try again.",
    action: "retry",
  },

  /* ── Throttling ──────────────────────────────────────────────────────── */

  // The description is rewritten at call time from `retryAfterSeconds`; see
  // `withRetryAfter` in `auth-errors.ts`.
  RATE_LIMITED: {
    title: "Too many attempts",
    description: "Please wait a moment, then try again.",
    action: "retry",
  },

  /* ── Two-factor ──────────────────────────────────────────────────────── */

  TWO_FACTOR_REQUIRED: {
    title: "Set up two-factor authentication",
    description: "Staff accounts need a second factor before you can continue.",
    action: "enroll-2fa",
  },
  TWO_FACTOR_NOT_ENABLED: {
    title: "Two-factor isn't switched on",
    description: "Switch it on in Settings, then try again.",
    action: "enroll-2fa",
  },
  TWO_FACTOR_PLUGIN_DISABLED: {
    title: "Two-factor isn't available",
    description: "Contact support — this deployment is misconfigured.",
    action: "contact-support",
  },
  TOTP_NOT_ENABLED: {
    title: "Authenticator app not set up",
    description: "Add an authenticator app, or use a backup code instead.",
    action: "enroll-2fa",
  },
  OTP_NOT_ENABLED: {
    title: "Email codes aren't available",
    description: "Use your authenticator app or a backup code instead.",
  },
  BACKUP_CODES_NOT_ENABLED: {
    title: "No backup codes",
    description: "Generate backup codes in Settings before you need them.",
    action: "enroll-2fa",
  },
  INVALID_CODE: {
    title: "That code isn't right",
    description: "Check the code and try again.",
    field: "code",
  },
  INVALID_BACKUP_CODE: {
    title: "That backup code isn't right",
    description: "Each backup code works once. Try another, or generate new ones.",
    field: "code",
  },
  INVALID_TWO_FACTOR_COOKIE: {
    title: "Your verification expired",
    description: "Sign in again to start a new one.",
    action: "sign-in",
  },
  OTP_HAS_EXPIRED: {
    title: "That code has expired",
    description: "Request a new one — codes are short-lived.",
    action: "retry",
  },
  TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE: {
    title: "Too many code attempts",
    description: "Request a fresh code, then try again.",
    action: "retry",
  },

  /* ── Captcha ─────────────────────────────────────────────────────────── */

  VERIFICATION_FAILED: {
    title: "Please confirm you're human",
    description:
      "The check didn't pass. Tap the box again — it only takes a moment.",
    action: "retry",
  },
  MISSING_RESPONSE: {
    title: "Please complete the check",
    description: "Finish the 'confirm you're human' box, then try again.",
    action: "retry",
  },
  CAPTCHA_SERVICE_UNAVAILABLE: {
    title: "The security check didn't load",
    description: "Refresh the page and try again in a moment.",
    action: "retry",
  },

  /* ── Edge rejections (never reached Better Auth) ─────────────────────── */

  REQUEST_REJECTED: {
    title: "This sign-in request was blocked",
    description:
      "Our security policy stopped the request before it reached the sign-in service. If you're on a preview deployment, use the main site's address instead.",
    action: "retry",
  },
  CROSS_SITE_NAVIGATION_LOGIN_BLOCKED: {
    title: "Sign-in blocked for your safety",
    description: "This looked like a cross-site request. Open the app directly and sign in there.",
    action: "sign-in",
  },
  INVALID_ORIGIN: {
    title: "This sign-in request was blocked",
    description: "The address this page was opened from isn't recognised.",
    action: "retry",
  },
  MISSING_OR_NULL_ORIGIN: {
    title: "This sign-in request was blocked",
    description: "Open the app in a normal browser tab and try again.",
    action: "retry",
  },
  INVALID_CALLBACK_URL: {
    title: "This link is incomplete",
    description: "Part of the address is missing. Request a new one.",
    action: "request-new-link",
  },
  INVALID_REDIRECT_URL: {
    title: "This link is incomplete",
    description: "Part of the address is missing. Request a new one.",
    action: "request-new-link",
  },
  INVALID_ERROR_CALLBACK_URL: {
    title: "This link is incomplete",
    description: "Part of the address is missing. Request a new one.",
    action: "request-new-link",
  },
  INVALID_NEW_USER_CALLBACK_URL: {
    title: "This link is incomplete",
    description: "Part of the address is missing. Request a new one.",
    action: "request-new-link",
  },

  /* ── Entitlement (B2C) ──────────────────────────────────────────────── */

  PLAN_FEATURE_NOT_INCLUDED: {
    title: "Not on your plan",
    description: "Upgrade your plan to unlock this.",
    action: "upgrade-plan",
  },
  PLAN_LIMIT_REACHED: {
    title: "You've reached your plan's limit",
    description: "Upgrade your plan, or wait for the current cycle to reset.",
    action: "upgrade-plan",
  },

  /* ── Impersonation ───────────────────────────────────────────────────── */

  IMPERSONATION_BLOCKED: {
    title: "Not allowed while viewing another account",
    description:
      "This action changes real money or data, so it can't be done on someone's behalf. Sign back in as yourself.",
    action: "sign-in",
  },

  /* ── Validation (Better Auth's zod layer) ────────────────────────────── */

  VALIDATION_ERROR: {
    title: "Check the form",
    description: "One of the fields needs fixing.",
  },
  MISSING_FIELD: {
    title: "Check the form",
    description: "One of the fields is empty.",
  },
  FIELD_NOT_ALLOWED: {
    title: "We can't change that",
    description: "That field isn't editable here.",
  },
  BODY_MUST_BE_AN_OBJECT: {
    title: "We couldn't read that request",
    description: "Please try again.",
    action: "retry",
  },
  ASYNC_VALIDATION_NOT_SUPPORTED: {
    title: "We couldn't read that request",
    description: "Please try again.",
    action: "retry",
  },
  METHOD_NOT_ALLOWED_DEFER_SESSION_REQUIRED: {
    title: "We couldn't read that request",
    description: "Please refresh the page and try again.",
    action: "retry",
  },
} as const satisfies Record<AuthErrorCode, AuthErrorCopy>;

/* -------------------------------------------------------------------------- */
/* Per-flow overrides                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Codes whose sentence depends on which page is asking. A password-reset link
 * and a verification link are both `INVALID_TOKEN`; telling a customer their
 * verification link "lasts 30 minutes" when it lasts an hour is worse than the
 * generic sentence.
 *
 * Partial by construction: an override is an amendment to the base entry, not a
 * replacement, so a flow override only has to state what differs.
 */
export const AUTH_ERROR_COPY_BY_FLOW: Readonly<
  Partial<Record<AuthFlowName, Readonly<Record<string, Partial<AuthErrorCopy>>>>>
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
  },
  verify: {
    INVALID_TOKEN: {
      title: "This verification link no longer works",
      description: "Verification links last 1 hour and work once. Request a fresh one.",
      action: "resend-verification" as const,
    },
    TOKEN_EXPIRED: {
      title: "This verification link has expired",
      description: "Verification links last 1 hour. Request a fresh one below.",
      action: "resend-verification" as const,
    },
  },
  forgot: {
    // Deliberately absent: the forgot-password response is uniform for a known
    // and an unknown address, and the *uniform success* copy is the answer.
    // Nothing here may vary on whether the address exists.
  },
};

/* -------------------------------------------------------------------------- */
/* Lookup helpers (avoid a `as never` cast at every call site)                */
/* -------------------------------------------------------------------------- */

/** The base copy for a code, or `undefined` when the code is not ours. */
export function baseAuthErrorCopy(
  code: string,
): AuthErrorCopy | undefined {
  return (AUTH_ERROR_COPY as Record<string, AuthErrorCopy>)[code];
}

/** The per-flow amendment for a code, or `undefined` when the flow has none. */
export function flowAuthErrorCopy(
  flow: AuthFlowName,
  code: string,
): Partial<AuthErrorCopy> | undefined {
  return AUTH_ERROR_COPY_BY_FLOW[flow]?.[code];
}

/** Re-declared here so this module has no import cycle on `auth-errors.ts`. */
export type AuthFlowName = "signin" | "signup" | "forgot" | "reset" | "verify";

export type { AuthFlowName as AuthFlow };
