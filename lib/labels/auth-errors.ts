/**
 * The single place a Better Auth (or app-rail) failure becomes a sentence.
 *
 * Resolution order, and why:
 *
 *   1. **Code.** `lib/labels/auth-errors.catalog.ts` is exhaustive over
 *      `AuthErrorCode`, so a matched code always has copy. Codes are matched
 *      case-insensitively and trimmed, because a hand-written `Refusal` is not
 *      obliged to match Better Auth's casing.
 *   2. **Flow override.** The same code can read differently per page (see
 *      `AUTH_ERROR_COPY_BY_FLOW`).
 *   3. **Status.** A code-less 429 becomes a timed message; a code-less 401/403
 *      becomes `REQUEST_REJECTED`, not the generic sentence. The previous
 *      version fell through to `GENERIC[flow]`, which turned a `trustedOrigins`
 *      misconfiguration on a deploy preview into "Something went wrong on our
 *      side" — the single most confusing auth failure this app can produce.
 *   4. **Generic**, per flow, as a true last resort.
 *
 * The raw `error.message` is *never* returned. Not for a known code, not for an
 * unknown one, not in a fallback. Better Auth's messages are developer-facing
 * ("Invalid email or password"); `lib/sso/signin-with-toast.ts` used to render
 * one verbatim, and a SAML parse failure surfaced to a customer as
 * `TypeError: Cannot read properties of undefined (reading 'metadata')`.
 */

import {
  AUTH_ERROR_COPY,
  UNREACHABLE,
  baseAuthErrorCopy,
  flowAuthErrorCopy,
  type AuthErrorCopy,
  type AuthErrorField,
  type AuthFlow,
} from "./auth-errors.catalog";
import { normalizeAuthErrorCode } from "./auth-error-codes";

// This module is the app's single import seam for the catalog, so the re-exports
// below are load-bearing for every page. Written as `export … from` rather than
// "import, then export the local binding" so each name has exactly one
// declaration — the catalog — and none of them can be renamed here alone.
export type {
  AuthErrorAction,
  AuthErrorCopy,
  AuthErrorField,
  AuthFlow,
} from "./auth-errors.catalog";
export { AUTH_ERROR_COPY, UNREACHABLE } from "./auth-errors.catalog";

/* -------------------------------------------------------------------------- */
/* Input                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The shape `authClient.*` returns — the JSON body plus `status` — widened with
 * the fields our own rails add.
 */
export interface AuthClientError {
  code?: string;
  message?: string;
  /** Our limiter and route helpers answer `{ error, code }`. */
  error?: string;
  status?: number;
  /**
   * `Retry-After`, in seconds. Present on our 429s. Better Auth's own
   * rate-limit error does not carry it, which is why the copy is rewritten at
   * the call site rather than read from the error object.
   */
  retryAfterSeconds?: number;
  /** Which limiter fired — lets the page name the window ("sign-in", "reset"). */
  scope?: string;
}

export interface HumanizeOptions {
  /** Overrides `error.retryAfterSeconds` — useful when the page parsed a header. */
  retryAfterSeconds?: number;
}

/* -------------------------------------------------------------------------- */
/* Retry-After                                                               */
/* -------------------------------------------------------------------------- */

/**
 * "in 12 minutes", not "in 731 seconds" and not "in a moment".
 *
 * Rounding is deliberately coarse and *up*: a customer told to come back in
 * "9 minutes" for a 9m30s wait has been told to come back too early, and the
 * natural reaction is to hammer the button — which is exactly the behaviour a
 * rate limit exists to interrupt.
 */
export function formatRetryAfter(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "a moment";
  const total = Math.ceil(seconds);
  if (total < 60) return `${total} second${total === 1 ? "" : "s"}`;
  const minutes = Math.ceil(total / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.ceil(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"}`;
  return `${Math.ceil(hours / 24)} days`;
}

/** `RATE_LIMITED` gains a real time to wait. */
function withRetryAfter(
  copy: AuthErrorCopy,
  seconds: number | undefined,
): AuthErrorCopy {
  if (seconds === undefined) return copy;
  return {
    ...copy,
    description: `Try again in ${formatRetryAfter(seconds)}.`,
  };
}

/* -------------------------------------------------------------------------- */
/* Validation-message sniffing                                               */
/* -------------------------------------------------------------------------- */

/**
 * Better Auth validates the request body with zod *before* its own codes
 * apply, so a blank field arrives as `VALIDATION_ERROR` / `MISSING_FIELD` with
 * a message like `[body.email] Invalid email`. Only the field name is read from
 * it — never the value, which is user input and may itself be sensitive.
 */
function fieldFromValidationMessage(
  message: string | undefined,
): AuthErrorField | null {
  if (!message) return null;
  if (/\[body\.email\]/i.test(message)) return "email";
  if (/\[body\.newPassword\]/i.test(message)) return "newPassword";
  if (/\[body\.(password|currentPassword)\]/i.test(message)) return "password";
  if (/\[body\.(code|otp|token)\]/i.test(message)) return "code";
  return null;
}

/* -------------------------------------------------------------------------- */
/* Resolution                                                                */
/* -------------------------------------------------------------------------- */

/** Better Auth validates with zod before its own codes apply. */
const VALIDATION_CODES = new Set(["VALIDATION_ERROR", "MISSING_FIELD"]);

/**
 * The title/description pair for a field the validation sniffer recovered.
 *
 * A table rather than a chain of conditionals, deliberately: a chain chooses a
 * sentence by fall-through, so the "no field matched" case is whichever branch
 * was written last and a reader has to prove it. Here every field the sniffer
 * can return has its own row, and typing the table over `AuthErrorField` means
 * a *new* field is a compile error in this file rather than a customer reading
 * a sentence nobody chose. That is the same exhaustiveness bargain the catalog
 * itself makes over `AuthErrorCode`.
 */
const VALIDATION_FIELD_COPY: Record<
  AuthErrorField,
  Pick<AuthErrorCopy, "title" | "description">
> = {
  email: {
    title: "Check the email address",
    description: "Enter a valid email address.",
  },
  newPassword: {
    title: "Enter a new password",
    description: "This field can't be empty.",
  },
  password: {
    title: "Check this field",
    description: "This field can't be empty.",
  },
  code: {
    title: "Check this field",
    description: "Enter the code from your app or email.",
  },
  // Unreachable from `fieldFromValidationMessage`, which never sniffs a
  // referral field. Listed so the table stays exhaustive over `AuthErrorField`
  // and keeps the generic sentence rather than becoming a runtime miss.
  referral: {
    title: "Check this field",
    description: "This field can't be empty.",
  },
};

function copyForCode(
  flow: AuthFlow,
  code: string,
  message: string | undefined,
): AuthErrorCopy | null {
  // The validation codes are checked FIRST, and must be, because
  // `AUTH_ERROR_COPY` has generic entries for them with no `field`. Looking
  // those up before the sniff would return the generic sentence and the field
  // would never be recovered — which is the whole value of the code, since
  // BetterAuth's own zod message ("[body.email] Invalid email") is the only
  // signal that names the offending input. Only the field *token* is read from
  // that message; the message itself is never returned.
  if (VALIDATION_CODES.has(code)) {
    const field = fieldFromValidationMessage(message);
    if (!field) return baseAuthErrorCopy(code) ?? null;
    return { ...VALIDATION_FIELD_COPY[field], field };
  }

  const perFlow = flowAuthErrorCopy(flow, code);
  const base = baseAuthErrorCopy(code);

  // A flow override is an *amendment* to the base entry, so a base must exist.
  // `AUTH_ERROR_COPY` is exhaustive over `AuthErrorCode` and every key of
  // `AUTH_ERROR_COPY_BY_FLOW` is an `AuthErrorCode`, so this cannot be null for
  // a code we recognise — but the check keeps a future bad override from
  // rendering a `{ title: undefined }` toast instead of failing loudly.
  if (perFlow) {
    if (!base) {
      throw new Error(
        `auth-errors: flow override for "${flow}/${code}" has no base entry in AUTH_ERROR_COPY`,
      );
    }
    return { ...base, ...perFlow };
  }

  return base ?? null;
}

const GENERIC: Record<AuthFlow, AuthErrorCopy> = {
  signin: {
    title: "Sign-in failed",
    description: "Something went wrong on our side. Please try again.",
    action: "retry",
  },
  signup: {
    title: "We couldn't create your account",
    description: "Something went wrong on our side. Please try again.",
    action: "retry",
  },
  forgot: {
    title: "We couldn't send the reset link",
    description: "Please try again in a moment.",
    action: "retry",
  },
  reset: {
    title: "We couldn't reset your password",
    description: "Please try again, or request a new link.",
    action: "request-new-link",
  },
  verify: {
    title: "We couldn't verify that link",
    description: "Request a fresh one below.",
    action: "request-new-link",
  },
};

/**
 * Status fallback, for a failure that carried no usable code.
 *
 * The 401/403 branch is the important one. Those statuses out of `/api/auth/*`
 * mean the request never reached a handler — a `trustedOrigins` or CSRF
 * rejection at the edge — which is a *deployment* problem, not a customer's
 * password. Answering it with `GENERIC[flow]` told a correct password that
 * "something went wrong on our side", and gave support nothing to look at.
 */
function copyForStatus(
  flow: AuthFlow,
  status: number | undefined,
  retryAfterSeconds: number | undefined,
): AuthErrorCopy {
  if (status === undefined) return GENERIC[flow];
  if (status === 429) {
    return withRetryAfter(AUTH_ERROR_COPY.RATE_LIMITED, retryAfterSeconds);
  }
  if (status === 0 || status >= 500) return UNREACHABLE;
  if (status === 401 || status === 403) return AUTH_ERROR_COPY.REQUEST_REJECTED;
  if (status === 428) {
    // "Precondition required" is what the mandatory-2FA gate answers. It is not
    // currently reachable — the gate always sends `TWO_FACTOR_REQUIRED`, which
    // the code table catches first — so this is one line of defence against a
    // future 428 arriving from a route that forgets to set a code. Answering it
    // as "something went wrong on our side" would be actively misleading: the
    // request was refused on purpose and the customer has something to do.
    return AUTH_ERROR_COPY.TWO_FACTOR_REQUIRED;
  }
  if (status === 410) {
    return {
      title: "This link is no longer available",
      description: "It was revoked or has already been used.",
      action: "request-new-link",
    };
  }
  if (status === 409) {
    return {
      title: "That conflicts with something already saved",
      description: "Refresh the page and try again.",
      action: "retry",
    };
  }
  return GENERIC[flow];
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                               */
/* -------------------------------------------------------------------------- */

export function humanizeAuthError(
  flow: AuthFlow,
  error: AuthClientError | null | undefined,
  options: HumanizeOptions = {},
): AuthErrorCopy {
  if (!error) return GENERIC[flow];

  const retryAfter = options.retryAfterSeconds ?? error.retryAfterSeconds;
  const code = normalizeAuthErrorCode(error.code);
  const byCode = code ? copyForCode(flow, code, error.message) : null;
  return byCode ?? copyForStatus(flow, error.status, retryAfter);
}
