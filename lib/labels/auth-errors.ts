/**
 * Single-source authentication error catalog and humanizer.
 *
 * Maps Better Auth and app-minted error codes to customer-facing copy without
 * ever echoing raw server/library error strings (`error.message`).
 */

export type AuthErrorField =
  "name" | "email" | "password" | "newPassword" | "referral" | "code";

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
const FIELDS = new Set<string>([
  "name",
  "email",
  "password",
  "newPassword",
  "referral",
  "code",
]);

function entry(
  title: string,
  description: string,
  first?: AuthErrorAction | AuthErrorField,
  action?: AuthErrorAction,
  needsVerification?: boolean,
): AuthErrorCopy {
  const out: AuthErrorCopy = { title, description };
  if (first) {
    if (FIELDS.has(first)) out.field = first as AuthErrorField;
    else out.action = first as AuthErrorAction;
  }
  if (action) out.action = action;
  if (needsVerification) out.needsVerification = true;
  return out;
}

export const UNREACHABLE: AuthErrorCopy = entry(
  "We couldn't reach the sign-in service",
  "Nothing was changed. Please try again in a moment.",
  "retry",
);

export const AUTH_ERROR_COPY = {
  INVALID_EMAIL_OR_PASSWORD: entry(
    "That email and password don't match",
    "Check both and try again, or use Forgot password?",
    "password",
    "forgot-password",
  ),
  INVALID_PASSWORD: entry(
    "That password didn't work",
    "Check for a capital letter or a typo, then try again.",
    "password",
    "forgot-password",
  ),
  CREDENTIAL_ACCOUNT_NOT_FOUND: entry(
    "This account has no password",
    "You signed up with Google or GitHub, or through your organisation's SSO. Use that button instead.",
  ),
  USER_NOT_FOUND: entry(
    "We couldn't find that account",
    "It may have been deleted. Sign up again to start over.",
    "sign-up",
  ),
  EMAIL_NOT_VERIFIED: entry(
    "Verify your email first",
    "Enter the 6-digit code we emailed you. Used Google or GitHub? Verify this address with them first.",
    "resend-verification",
    undefined,
    true,
  ),
  BANNED_USER: entry(
    "This account is suspended",
    `Contact ${SUPPORT} if you think this is a mistake.`,
    "contact-support",
  ),
  SESSION_EXPIRED: entry(
    "Your session has expired",
    "For your security, sign in again to continue.",
    "sign-in",
  ),
  SESSION_NOT_FRESH: entry(
    "Please sign in again",
    "This is a sensitive action, so we ask you to confirm it's you.",
    "sign-in",
  ),
  SESSION_LOOKUP_FAILED: UNREACHABLE,
  USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: entry(
    "This email already has an account",
    "Sign in instead, or reset your password if you forgot it.",
    "email",
    "sign-in",
  ),
  PASSWORD_ALREADY_SET: entry(
    "This account already has a password",
    "Sign in instead of creating a new account.",
    "email",
    "sign-in",
  ),
  FAILED_TO_UPDATE_USER: entry(
    "We couldn't save that change",
    "Nothing was changed. Please try again.",
    "retry",
  ),
  FAILED_TO_CREATE_USER: entry(
    "We couldn't create your account",
    "Nothing was saved. Try again, or sign in if you already have an account.",
    "retry",
  ),
  NAME_INVALID: entry(
    "Check your name",
    "Use up to 80 characters, without links, email addresses or phone numbers.",
    "name",
  ),
  INVALID_EMAIL: entry(
    "Check the email address",
    "Enter a valid email address.",
    "email",
  ),
  PASSWORD_TOO_SHORT: entry(
    "Password too short",
    "Use at least 8 characters.",
    "password",
  ),
  PASSWORD_TOO_LONG: entry(
    "Password too long",
    "Use at most 72 bytes: about 72 letters or digits, fewer with emoji or non-Latin scripts.",
    "password",
  ),
  PASSWORD_COMPROMISED: entry(
    "Choose a different password",
    "This password has appeared in a data breach, so attackers try it first. Pick one you don't use anywhere else.",
    "password",
  ),
  INVALID_TOKEN: entry(
    "This link no longer works",
    "It is invalid or has already been used. Request a new one.",
    "request-new-link",
  ),
  TOKEN_EXPIRED: entry(
    "This link has expired",
    "Request a new one — links are single-use and time-limited.",
    "request-new-link",
  ),
  INVALID_OTP: entry(
    "That code isn't right",
    "Check the 6-digit code in the email and try again.",
    "code",
  ),
  OTP_EXPIRED: entry(
    "This code has expired",
    "Codes last 10 minutes. Send a new one below.",
    "code",
    "resend-verification",
  ),
  TOO_MANY_ATTEMPTS: entry(
    "Too many wrong codes",
    "For your security that code no longer works. Send a new one below.",
    "code",
    "resend-verification",
  ),
  FAILED_TO_UNLINK_LAST_ACCOUNT: entry(
    "You need one way to sign in",
    "Add a password or another provider before disconnecting this one.",
  ),
  ACCOUNT_NOT_FOUND: entry(
    "We couldn't find that connection",
    "Refresh the page and try again.",
    "retry",
  ),
  PROVIDER_NOT_FOUND: entry(
    "That sign-in method isn't available",
    "Use your email and password instead.",
    "sign-in",
  ),
  INVITATION_NOT_FOUND: entry(
    "This invitation link isn't valid",
    "It may have been revoked. Ask whoever invited you for a new one.",
    "contact-support",
  ),
  INVITATION_EXPIRED: entry(
    "This invitation has expired",
    "Ask for a new one — invitations last 14 days.",
    "contact-support",
  ),
  INVITATION_ALREADY_ACCEPTED: entry(
    "This invitation was already accepted",
    "Open the organisation from your dashboard to get started.",
    "retry",
  ),
  INVITATION_NOT_FOR_YOU: entry(
    "This invitation isn't for you",
    "It was sent to a different email address.",
    "contact-support",
  ),
  SSO_REQUIRED: entry(
    "Use your organisation's sign-in",
    "Your organisation requires its own sign-in for this email, so password and Google sign-in are turned off. Use the SSO button below.",
    "email",
    "switch-to-sso",
  ),
  SSO_PROVIDER_MISCONFIGURED: entry(
    "Your organisation's sign-in is not set up yet",
    `Ask an administrator to finish the SSO setup, or contact ${SUPPORT}.`,
    "contact-support",
  ),
  SSO_EMAIL_DOMAIN_MISMATCH: entry(
    "This email isn't on your organisation's domain",
    `Sign in another way, or ask your administrator to check the SSO setup. Still stuck? Contact ${SUPPORT}.`,
    "contact-support",
  ),
  SSO_ORGANIZATION_INACTIVE: entry(
    "Your organisation's sign-in is paused",
    `Your organisation's account is suspended, so its single sign-on is off. Ask your administrator, or contact ${SUPPORT}.`,
    "contact-support",
  ),
  SSO_NOT_PROVEN: entry(
    "Sign in with SSO first",
    "An organisation owner must complete one successful SSO sign-in before SSO can be required for everyone.",
  ),
  SSO_ID_TOKEN_MISSING: entry(
    "Your organisation's sign-in didn't finish",
    `Your identity provider didn't send the details we need. Try again, and if it keeps happening ask your organisation's administrator to check the SSO setup or contact ${SUPPORT}.`,
    "retry",
  ),
  SSO_EMAIL_NOT_VERIFIED: entry(
    "Your organisation hasn't confirmed this email",
    "Your identity provider didn't confirm that this email address belongs to you. Ask your organisation's administrator to verify it, then sign in again.",
    "contact-support",
  ),
  SSO_HOSTED_DOMAIN_MISMATCH: entry(
    "Use your work account",
    "That looks like a personal account. Sign in with the account your organisation gave you, not a personal one.",
    "retry",
  ),
  SSO_ACCOUNT_ALREADY_LINKED: entry(
    "This account uses a different organisation sign-in",
    "It's already connected to another identity at your organisation's provider. Sign in with that account, or ask your organisation's administrator for help.",
    "sign-in",
  ),
  // OAuth and SSO callbacks redirect with lowercase codes; lookup upper-cases them.
  ACCOUNT_NOT_LINKED: entry(
    "Reset your password to connect this account",
    "An account with this email exists but its address isn't verified, so we can't connect Google or GitHub to it. Reset its password to prove the address is yours, then try again.",
    "forgot-password",
  ),
  UNABLE_TO_LINK_ACCOUNT: entry(
    "We couldn't connect that sign-in method",
    "Sign in the way you did before, then try again.",
    "sign-in",
  ),
  ACCOUNT_ALREADY_LINKED_TO_DIFFERENT_USER: entry(
    "That account belongs to someone else",
    "This Google or GitHub account is connected to a different Familiarise account. Sign in to that one instead.",
    "sign-in",
  ),
  ACCOUNT_OWNERSHIP_CONFLICT: entry(
    "That account belongs to someone else",
    "This sign-in is connected to a different Familiarise account. Sign in to that one instead.",
    "sign-in",
  ),
  EMAIL_DOES_NOT_MATCH: entry(
    "That account uses a different email",
    "Use a Google or GitHub account with the same email address as your Familiarise account.",
  ),
  EMAIL_NOT_FOUND: entry(
    "Your provider didn't share an email address",
    "Make an email address visible in your Google or GitHub settings, or sign up with email and password.",
    "sign-up",
  ),
  ACCESS_DENIED: entry(
    "Sign-in was cancelled",
    "Access wasn't granted on the provider's page. Try again, or sign in another way.",
    "retry",
  ),
  STATE_MISMATCH: entry(
    "This sign-in expired",
    "It took too long or was started in another tab. Start again from this page.",
    "retry",
  ),
  STATE_NOT_FOUND: entry(
    "This sign-in expired",
    "It took too long or was started in another tab. Start again from this page.",
    "retry",
  ),
  INVALID_STATE: entry(
    "This sign-in expired",
    "It took too long or was started in another tab. Start again from this page.",
    "retry",
  ),
  PLEASE_RESTART_THE_PROCESS: entry(
    "This sign-in expired",
    "Start again from this page.",
    "retry",
  ),
  INVALID_CALLBACK_REQUEST: entry(
    "This sign-in link isn't valid",
    "Start again from this page.",
    "retry",
  ),
  NO_CODE: entry(
    "The provider sign-in didn't complete",
    "Please try again. If it keeps happening, sign in with email and password.",
    "retry",
  ),
  UNABLE_TO_GET_USER_INFO: entry(
    "The provider sign-in didn't complete",
    "We couldn't read your profile from the provider. Please try again.",
    "retry",
  ),
  OAUTH_PROVIDER_NOT_FOUND: entry(
    "That sign-in method isn't available",
    "Use your email and password instead.",
    "sign-in",
  ),
  ISSUER_MISMATCH: entry(
    "The provider sign-in couldn't be verified",
    "Please try again. If it keeps happening, sign in another way.",
    "retry",
  ),
  INVALID_PROVIDER: entry(
    "Your organisation's sign-in didn't work",
    `The response from your organisation's sign-in couldn't be verified. Try again, or ask your administrator to check the SSO setup. Still stuck? Contact ${SUPPORT}.`,
    "contact-support",
  ),
  TOKEN_NOT_VERIFIED: entry(
    "Your organisation's sign-in didn't work",
    `The response from your organisation's sign-in couldn't be verified. Try again, or ask your administrator to check the SSO setup. Still stuck? Contact ${SUPPORT}.`,
    "contact-support",
  ),
  UNABLE_TO_CREATE_USER: entry(
    "We couldn't finish creating your account",
    "Nothing was saved. Please try again.",
    "retry",
  ),
  UNABLE_TO_CREATE_SESSION: entry(
    "We couldn't finish signing you in",
    "Please try again.",
    "retry",
  ),
  SIGNUP_DISABLED: entry(
    "New accounts can't be created this way",
    "Sign up with email and password instead.",
    "sign-up",
  ),
  INTERNAL_SERVER_ERROR: UNREACHABLE,
  IDENTITY_CHANGED: entry(
    "You're signed in as someone else now",
    "Another tab switched accounts, so nothing was changed. Reload the page to continue as the current account.",
    "retry",
  ),
  TWO_FACTOR_OPERATORS_ONLY: entry(
    "Two-factor setup is for staff accounts",
    "Your account is protected by your password and your verified email.",
  ),
  SELF_RESET_FORBIDDEN: entry(
    "You can't reset your own two-factor",
    "Ask another administrator to reset it for you.",
    "contact-support",
  ),
  ALREADY_ONBOARDED: entry(
    "You're already set up",
    "Your account setup is complete. Open your dashboard to continue.",
  ),
  RATE_LIMITED: entry(
    "Too many attempts",
    "Please wait a moment, then try again.",
    "retry",
  ),
  TWO_FACTOR_REQUIRED: entry(
    "Set up two-factor authentication",
    "Staff accounts need a second factor before you can continue.",
    "enroll-2fa",
  ),
  STAFF_PASSWORD_SIGN_IN_ONLY: entry(
    "Sign in with your password",
    "Staff accounts sign in with email, password and an authenticator code.",
  ),
  TRUST_DEVICE_DISABLED: entry(
    "Trusted devices aren't available",
    "Enter a code from your authenticator app each time you sign in.",
  ),
  INVALID_CODE: entry(
    "That code isn't right",
    "Check the code and try again.",
    "code",
  ),
  INVALID_BACKUP_CODE: entry(
    "That backup code isn't right",
    "Each backup code works once. Try another, or generate new ones.",
    "code",
  ),
  INVALID_TWO_FACTOR_COOKIE: entry(
    "Your verification expired",
    "Sign in again to start a new one.",
    "sign-in",
  ),
  TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE: entry(
    "Too many wrong codes",
    "For your security, this sign-in was stopped. Sign in again to get a new verification step.",
    "sign-in",
  ),
  TOTP_NOT_ENABLED: entry(
    "Two-factor isn't set up yet",
    "Set up an authenticator app first, then try again.",
    "enroll-2fa",
  ),
  TOTP_ALREADY_ENABLED: entry(
    "Two-factor is already on",
    "Your authenticator app is already set up. Refresh the page to see your settings.",
    "retry",
  ),
  ACCOUNT_TEMPORARILY_LOCKED: entry(
    "Too many wrong codes",
    "For your security, two-factor sign-in is paused. Wait 15 minutes, then try again.",
    "code",
    "retry",
  ),
  REAUTH_REQUIRED: entry(
    "Confirm it's you",
    "This is a sensitive change, so we need you to confirm your identity first. Try again and complete the check.",
    "retry",
  ),
  PASSKEY_OPERATORS_ONLY: entry(
    "Passkeys are for staff accounts",
    "Passkeys are available to staff who have set up an authenticator app. Sign in with your email and password instead.",
  ),
  PASSKEY_USER_VERIFICATION_REQUIRED: entry(
    "Unlock your passkey",
    "Confirm with your device PIN, fingerprint or face, then try again.",
    "retry",
  ),
  PASSKEY_NOT_FOUND: entry(
    "We don't recognise that passkey",
    "It may have been removed. Sign in with your email and password instead.",
  ),
  ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED: entry(
    "This passkey is already added",
    "This device already has a passkey for your account.",
  ),
  REQUEST_REJECTED: entry(
    "This sign-in request was blocked",
    "Our security policy stopped the request before it reached the sign-in service. If you're on a preview deployment, use the main site's address instead.",
    "retry",
  ),
  INVALID_ORIGIN: entry(
    "This sign-in request was blocked",
    "The address this page was opened from isn't recognised.",
    "retry",
  ),
  VALIDATION_ERROR: entry("Check the form", "One of the fields needs fixing."),
} as const satisfies Record<string, AuthErrorCopy>;

export type AuthErrorCode = keyof typeof AUTH_ERROR_COPY;

export const AUTH_ERROR_CODES = Object.fromEntries(
  Object.keys(AUTH_ERROR_COPY).map((k) => [k, k]),
) as { readonly [K in AuthErrorCode]: K };

const KNOWN_CODES: ReadonlySet<string> = new Set(Object.keys(AUTH_ERROR_COPY));

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

/** WebAuthn ceremony codes for a dismissed or timed-out browser prompt; show nothing. */
const PASSKEY_CANCELLATION_CODES: ReadonlySet<string> = new Set([
  "AUTH_CANCELLED",
  "ERROR_CEREMONY_ABORTED",
  "ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY",
]);

export function isPasskeyCancellation(
  code: string | null | undefined,
): boolean {
  return !!code && PASSKEY_CANCELLATION_CODES.has(code);
}

export const AUTH_ERROR_COPY_BY_FLOW: Readonly<
  Partial<
    Record<AuthFlowName, Readonly<Record<string, Partial<AuthErrorCopy>>>>
  >
> = {
  reset: {
    INVALID_TOKEN: entry(
      "This reset link no longer works",
      "Reset links last 30 minutes and work once. Request a new one.",
      "request-new-link",
    ),
    TOKEN_EXPIRED: entry(
      "This reset link has expired",
      "Reset links last 30 minutes. Request a new one.",
      "request-new-link",
    ),
    PASSWORD_COMPROMISED: { field: "newPassword" },
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
  const units: Array<[number, number, string]> = [
    [60, 1, "second"],
    [3600, 60, "minute"],
    [86400, 3600, "hour"],
    [Infinity, 86400, "day"],
  ];
  for (const [limit, div, name] of units) {
    if (seconds < limit) {
      const n = Math.ceil(seconds / div);
      return n === 1 ? `1 ${name}` : `${n} ${name}s`;
    }
  }
  return "a moment";
}

function withRetryAfter(
  base: AuthErrorCopy,
  retryAfterSeconds: number | null | undefined,
): AuthErrorCopy {
  if (!retryAfterSeconds || retryAfterSeconds <= 0) return base;
  return {
    ...base,
    description: `For your security, please wait ${formatRetryAfter(retryAfterSeconds)} before trying again.`,
  };
}

const FLOW_FALLBACK_COPY: Record<AuthFlowName, AuthErrorCopy> = {
  signin: entry(
    "Couldn't sign you in",
    "Check the details you entered and try again.",
    "retry",
  ),
  signup: entry(
    "Couldn't create your account",
    "Check the details you entered and try again.",
    "retry",
  ),
  forgot: entry(
    "Couldn't send the reset link",
    "Check the email address and try again.",
    "retry",
  ),
  reset: entry(
    "Couldn't update your password",
    "The reset link may have expired. Request a new one and try again.",
    "request-new-link",
  ),
  verify: entry(
    "Couldn't verify your email",
    "The code may have expired. Send a new one and try again.",
    "resend-verification",
  ),
};

function copyForStatus(
  flow: AuthFlowName,
  status: number | null | undefined,
  retryAfterSeconds: number | null | undefined,
): AuthErrorCopy {
  if (status === 429)
    return withRetryAfter(AUTH_ERROR_COPY.RATE_LIMITED, retryAfterSeconds);
  if (status === 401 || status === 403) return AUTH_ERROR_COPY.REQUEST_REJECTED;
  if (status === 0 || (typeof status === "number" && status >= 500))
    return UNREACHABLE;
  return FLOW_FALLBACK_COPY[flow];
}

function fieldFromValidationMessage(
  flow: AuthFlowName,
  message: string | null | undefined,
): Partial<AuthErrorCopy> | null {
  if (!message) return null;
  if (message.includes("[body.email]")) return AUTH_ERROR_COPY.INVALID_EMAIL;
  if (message.includes("[body.name]")) return AUTH_ERROR_COPY.NAME_INVALID;
  if (
    message.includes("[body.password]") ||
    message.includes("[body.newPassword]")
  ) {
    const field: AuthErrorField =
      flow === "reset" && message.includes("[body.newPassword]")
        ? "newPassword"
        : "password";
    if (message.includes("Too small"))
      return { ...AUTH_ERROR_COPY.PASSWORD_TOO_SHORT, field };
    if (message.includes("Too big"))
      return { ...AUTH_ERROR_COPY.PASSWORD_TOO_LONG, field };
    return entry(
      "Check the password",
      "Use at least 8 characters and at most 72 bytes.",
      field,
    );
  }
  return null;
}

function extractError(error: unknown): AuthClientError {
  if (!error || typeof error !== "object") return {};
  const e = error as Record<string, unknown>;
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
  const {
    code: rawCode,
    status,
    message,
    retryAfterSeconds,
  } = extractError(error);
  const wait = options?.retryAfterSeconds ?? retryAfterSeconds;

  const code = normalizeAuthErrorCode(rawCode);
  if (code) {
    if (code === "VALIDATION_ERROR") {
      const fromField = fieldFromValidationMessage(flow, message);
      if (fromField?.title && fromField.description)
        return fromField as AuthErrorCopy;
    }
    const base = AUTH_ERROR_COPY[code];
    if (base) {
      const override = AUTH_ERROR_COPY_BY_FLOW[flow]?.[code];
      const merged: AuthErrorCopy = override ? { ...base, ...override } : base;
      if (code === "RATE_LIMITED" || status === 429)
        return withRetryAfter(merged, wait);
      return merged;
    }
  }

  return copyForStatus(flow, status, wait);
}
