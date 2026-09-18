/**
 * One place that turns a Better Auth client error into the sentence the
 * customer reads, keyed on the server's `code` first and the HTTP status
 * second. The sign-in page used to guess from the message text, and the
 * wrong-password message ("Invalid email or password") matched its
 * "invalid" + "email" branch, so every wrong password read as a malformed
 * address. Codes come from `@better-auth/core` (error/codes), the admin
 * plugin (BANNED_USER), and our own hooks and limiter (SSO_REQUIRED,
 * RATE_LIMITED). Sign-in and password-reset deliberately never reveal
 * whether an address exists, and neither does this copy.
 */

export type AuthFlow = "signin" | "signup" | "forgot" | "reset" | "verify";

/** The shape `authClient.*` returns: the JSON body plus `status`. */
export interface AuthClientError {
  code?: string;
  message?: string;
  /** Our limiter and route helpers answer `{ error, code }`. */
  error?: string;
  status?: number;
}

export type AuthErrorField = "email" | "password" | "referral";

export interface AuthErrorCopy {
  title: string;
  description: string;
  /** The input the sentence belongs under, when there is one. */
  field?: AuthErrorField;
  /** True when the page should switch to its "verify your email" state. */
  needsVerification?: boolean;
}

const SUPPORT = "support@familiarisenow.com";

const UNREACHABLE: AuthErrorCopy = {
  title: "We couldn't reach the sign-in service",
  description: "Nothing was changed. Please try again in a moment.",
};

const RATE_LIMITED: AuthErrorCopy = {
  title: "Too many attempts",
  description: "Wait a minute, then try again.",
};

const BY_CODE: Record<string, AuthErrorCopy> = {
  INVALID_EMAIL: {
    title: "Check the email address",
    description: "Enter a valid email address.",
    field: "email",
  },
  INVALID_EMAIL_OR_PASSWORD: {
    title: "That email and password don't match",
    description:
      "Check both and try again. If you signed up with Google or through your organisation's SSO, use that button instead.",
    field: "password",
  },
  EMAIL_NOT_VERIFIED: {
    title: "Verify your email first",
    description: "Your email isn't verified yet — resend the link below.",
    needsVerification: true,
  },
  BANNED_USER: {
    title: "This account is suspended",
    description: `Contact ${SUPPORT} if you think this is a mistake.`,
  },
  SSO_REQUIRED: {
    title: "Use your organisation's sign-in",
    description:
      "This email domain signs in through your organisation's SSO. Use the SSO button.",
    field: "email",
  },
  USER_ALREADY_EXISTS: {
    title: "This email already has an account",
    description: "Sign in instead, or reset your password if you forgot it.",
    field: "email",
  },
  USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: {
    title: "This email already has an account",
    description: "Sign in instead, or reset your password if you forgot it.",
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
  INVALID_PASSWORD: {
    title: "Check the password",
    description: "Choose a different password and try again.",
    field: "password",
  },
  INVALID_TOKEN: {
    title: "This link no longer works",
    description: "It is invalid or has expired. Request a new one.",
  },
  TOKEN_EXPIRED: {
    title: "This link has expired",
    description: "Request a new one and use it within 30 minutes.",
  },
  EMAIL_ALREADY_VERIFIED: {
    title: "Already verified",
    description: "This email is verified — you can sign in.",
  },
  EMAIL_MISMATCH: {
    title: "Different address",
    description: "That address doesn't match the account you're signed in to.",
    field: "email",
  },
  USER_NOT_FOUND: {
    title: "We couldn't find that account",
    description: "The link may belong to a deleted account. Sign up again.",
  },
  SESSION_LOOKUP_FAILED: UNREACHABLE,
  RATE_LIMITED,
};

/** Only the flows where a code means something different per page. */
const BY_FLOW_AND_CODE: Partial<
  Record<AuthFlow, Record<string, AuthErrorCopy>>
> = {
  reset: {
    INVALID_TOKEN: {
      title: "This reset link no longer works",
      description:
        "Reset links last 30 minutes and work once. Request a new one.",
    },
  },
  verify: {
    INVALID_TOKEN: {
      title: "This verification link no longer works",
      description: "Request a fresh one below.",
    },
    TOKEN_EXPIRED: {
      title: "This verification link has expired",
      description: "Request a fresh one below.",
    },
  },
};

const GENERIC: Record<AuthFlow, AuthErrorCopy> = {
  signin: {
    title: "Sign-in failed",
    description: "Something went wrong on our side. Please try again.",
  },
  signup: {
    title: "We couldn't create your account",
    description: "Something went wrong on our side. Please try again.",
  },
  forgot: {
    title: "We couldn't send the reset link",
    description: "Please try again in a moment.",
  },
  reset: {
    title: "We couldn't reset your password",
    description: "Please try again, or request a new link.",
  },
  verify: {
    title: "We couldn't verify that link",
    description: "Request a fresh one below.",
  },
};

/**
 * Better Auth validates the body with zod before its own codes apply, so a
 * blank field arrives as `VALIDATION_ERROR` / `MISSING_FIELD` with a message
 * like "[body.email] Invalid email". Only the field name is read from it.
 */
function fieldFromValidationMessage(message: string): AuthErrorField | null {
  if (/\[body\.email\]/i.test(message)) return "email";
  if (/\[body\.(password|newPassword)\]/i.test(message)) return "password";
  return null;
}

const PASSWORD_REQUIRED: AuthErrorCopy = {
  title: "Enter your password",
  description: "The password field is required.",
  field: "password",
};

function copyForCode(
  flow: AuthFlow,
  code: string,
  message: string,
): AuthErrorCopy | null {
  const perFlow = BY_FLOW_AND_CODE[flow]?.[code];
  if (perFlow) return perFlow;
  const known = BY_CODE[code];
  if (known) return known;
  if (code !== "VALIDATION_ERROR" && code !== "MISSING_FIELD") return null;
  const field = fieldFromValidationMessage(message);
  if (field === "email") return BY_CODE.INVALID_EMAIL;
  if (field === "password") return PASSWORD_REQUIRED;
  return null;
}

function copyForStatus(flow: AuthFlow, status: number): AuthErrorCopy {
  if (status === 429) return RATE_LIMITED;
  if (status === 0 || status >= 500) return UNREACHABLE;
  return GENERIC[flow];
}

export function humanizeAuthError(
  flow: AuthFlow,
  error: AuthClientError | null | undefined,
): AuthErrorCopy {
  if (!error) return GENERIC[flow];
  const code = error.code?.toUpperCase();
  const byCode = code ? copyForCode(flow, code, error.message ?? "") : null;
  return byCode ?? copyForStatus(flow, error.status ?? 0);
}
