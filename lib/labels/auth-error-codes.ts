/**
 * The closed set of codes this app is willing to turn into a sentence.
 *
 * Two sources, deliberately kept apart:
 *
 *   - `BetterAuthErrorCode` — Better Auth codes a customer can actually reach
 *     through our UI. Each one is checked against `auth.$ERROR_CODES`, the
 *     table of the configured instance, so a code that a Better Auth upgrade
 *     renames or a removed plugin takes with it fails the build.
 *
 *   - `AppAuthErrorCode` — codes this codebase mints itself: the SSO veto in
 *     `lib/auth.ts`'s `session.create.before`, the edge rate limiter and the
 *     session-lookup tri-state.
 *
 * `lib/labels/auth-errors.catalog.ts` is a `Record<AuthErrorCode, AuthErrorCopy>`,
 * so every listed code must have copy. A code Better Auth returns that is NOT
 * listed (developer-facing validation errors, plugins we do not use) falls back
 * to the status-based sentence in `humanizeAuthError`, which never echoes the
 * server's message.
 */

import type { auth } from "@/lib/auth";

/* -------------------------------------------------------------------------- */
/* Better Auth                                                                */
/* -------------------------------------------------------------------------- */

/**
 * `@better-auth/core` `BASE_ERROR_CODES`, minus the ones only a malformed
 * request or a misconfigured deployment can produce.
 * @see node_modules/@better-auth/core/dist/error/codes.mjs
 */
export type BetterAuthCoreErrorCode =
  | "USER_NOT_FOUND"
  | "FAILED_TO_CREATE_USER"
  | "FAILED_TO_CREATE_SESSION"
  | "FAILED_TO_UPDATE_USER"
  | "FAILED_TO_GET_SESSION"
  | "INVALID_PASSWORD"
  | "INVALID_EMAIL"
  | "INVALID_EMAIL_OR_PASSWORD"
  | "INVALID_USER"
  | "SOCIAL_ACCOUNT_ALREADY_LINKED"
  | "PROVIDER_NOT_FOUND"
  | "INVALID_TOKEN"
  | "TOKEN_EXPIRED"
  | "FAILED_TO_GET_USER_INFO"
  | "USER_EMAIL_NOT_FOUND"
  | "EMAIL_NOT_VERIFIED"
  | "PASSWORD_TOO_SHORT"
  | "PASSWORD_TOO_LONG"
  | "USER_ALREADY_EXISTS"
  | "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL"
  | "CREDENTIAL_ACCOUNT_NOT_FOUND"
  | "SESSION_EXPIRED"
  | "FAILED_TO_UNLINK_LAST_ACCOUNT"
  | "ACCOUNT_NOT_FOUND"
  | "USER_ALREADY_HAS_PASSWORD"
  | "CROSS_SITE_NAVIGATION_LOGIN_BLOCKED"
  | "EMAIL_ALREADY_VERIFIED"
  | "EMAIL_MISMATCH"
  | "SESSION_NOT_FRESH"
  | "LINKED_ACCOUNT_ALREADY_EXISTS"
  | "INVALID_ORIGIN"
  | "INVALID_CALLBACK_URL"
  | "INVALID_REDIRECT_URL"
  | "INVALID_ERROR_CALLBACK_URL"
  | "INVALID_NEW_USER_CALLBACK_URL"
  | "MISSING_OR_NULL_ORIGIN"
  | "FAILED_TO_CREATE_VERIFICATION"
  | "VALIDATION_ERROR"
  | "MISSING_FIELD"
  | "PASSWORD_ALREADY_SET";

/**
 * `admin` plugin. Only the codes a signed-in user can plausibly hit — the
 * `YOU_ARE_NOT_ALLOWED_*` family is back-office authorisation, which the
 * backoffice refusal rail already answers with its own copy, and rendering it
 * on a public sign-in page would leak which administrative actions exist.
 * @see node_modules/better-auth/dist/plugins/admin/error-codes.mjs
 */
export type AdminPluginErrorCode = "BANNED_USER" | "USER_NOT_FOUND";

/**
 * `two-factor` plugin, TOTP and backup codes only (email OTP is not enabled).
 * @see node_modules/better-auth/dist/plugins/two-factor/error-code.mjs
 */
export type TwoFactorPluginErrorCode =
  | "TWO_FACTOR_NOT_ENABLED"
  | "TOTP_NOT_ENABLED"
  | "BACKUP_CODES_NOT_ENABLED"
  | "INVALID_CODE"
  | "INVALID_BACKUP_CODE"
  | "INVALID_TWO_FACTOR_COOKIE"
  | "TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE"
  | "ACCOUNT_TEMPORARILY_LOCKED";

/**
 * `have-i-been-pwned` plugin.
 * @see node_modules/better-auth/dist/plugins/haveibeenpwned/index.mjs
 */
export type HaveIBeenPwnedErrorCode = "PASSWORD_COMPROMISED";

export type BetterAuthErrorCode =
  | BetterAuthCoreErrorCode
  | AdminPluginErrorCode
  | TwoFactorPluginErrorCode
  | HaveIBeenPwnedErrorCode;

/** Every code the configured Better Auth instance (core + plugins) can return. */
type InstalledBetterAuthErrorCode = keyof typeof auth.$ERROR_CODES & string;

type AssertNoneMissing<T extends never> = T;

/**
 * Fails to compile, naming the code, when a listed code is not in the
 * installed table. Exported only so the alias is not flagged as unused.
 */
export type StaleBetterAuthErrorCode = AssertNoneMissing<
  Exclude<BetterAuthErrorCode, InstalledBetterAuthErrorCode>
>;

/* -------------------------------------------------------------------------- */
/* Ours                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Codes minted in this repo. Each one names the single file allowed to mint it,
 * so a new refusal has to be declared in the same commit that introduces it.
 */
export type AppAuthErrorCode =
  /* lib/auth.ts `session.create.before` — the SSO enforcement veto. */
  | "SSO_REQUIRED"
  /* lib/sso/enforce-session.ts — a provider row that cannot serve a sign-in. */
  | "SSO_PROVIDER_MISCONFIGURED"
  | "SSO_PROVIDER_UNREACHABLE"
  /* lib/rate-limit/* — 429. `scope` in the body says which limiter fired. */
  | "RATE_LIMITED"
  /* lib/auth-session-lookup.ts — the lookup threw; it did not answer "no". */
  | "SESSION_LOOKUP_FAILED"
  /* The request never reached Better Auth: origin/CORS/CSRF at the edge. */
  | "REQUEST_REJECTED"
  /* Server-enrolled 2FA that the client has not satisfied yet. */
  | "TWO_FACTOR_REQUIRED"
  /* lib/auth.ts `session.create.before` / `account.create.before` — an
     operator on a social/SSO path. */
  | "STAFF_PASSWORD_SIGN_IN_ONLY"
  /* lib/auth.ts `hooks.before` — trustDevice on a 2FA verify. */
  | "TRUST_DEVICE_DISABLED"
  /* app/organizations/invite/[token]/page.tsx — organisation invitations. */
  | "INVITATION_NOT_FOUND"
  | "INVITATION_EXPIRED"
  | "INVITATION_ALREADY_ACCEPTED"
  | "INVITATION_NOT_FOR_YOU";

export type AuthErrorCode = BetterAuthErrorCode | AppAuthErrorCode;

/* -------------------------------------------------------------------------- */
/* Runtime helpers                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Every literal in the union, for the "is this a code we know?" test.
 *
 * `AUTH_ERROR_CODES` is derived from the same `const` the types are written
 * against, so the runtime set and the compile-time union cannot drift — the
 * classic way a `Record<string, …>` guard quietly rots.
 */
export const AUTH_ERROR_CODES = {
  // Better Auth core
  USER_NOT_FOUND: "USER_NOT_FOUND",
  FAILED_TO_CREATE_USER: "FAILED_TO_CREATE_USER",
  FAILED_TO_CREATE_SESSION: "FAILED_TO_CREATE_SESSION",
  FAILED_TO_UPDATE_USER: "FAILED_TO_UPDATE_USER",
  FAILED_TO_GET_SESSION: "FAILED_TO_GET_SESSION",
  INVALID_PASSWORD: "INVALID_PASSWORD",
  INVALID_EMAIL: "INVALID_EMAIL",
  INVALID_EMAIL_OR_PASSWORD: "INVALID_EMAIL_OR_PASSWORD",
  INVALID_USER: "INVALID_USER",
  SOCIAL_ACCOUNT_ALREADY_LINKED: "SOCIAL_ACCOUNT_ALREADY_LINKED",
  PROVIDER_NOT_FOUND: "PROVIDER_NOT_FOUND",
  INVALID_TOKEN: "INVALID_TOKEN",
  TOKEN_EXPIRED: "TOKEN_EXPIRED",
  FAILED_TO_GET_USER_INFO: "FAILED_TO_GET_USER_INFO",
  USER_EMAIL_NOT_FOUND: "USER_EMAIL_NOT_FOUND",
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
  USER_ALREADY_HAS_PASSWORD: "USER_ALREADY_HAS_PASSWORD",
  CROSS_SITE_NAVIGATION_LOGIN_BLOCKED: "CROSS_SITE_NAVIGATION_LOGIN_BLOCKED",
  EMAIL_ALREADY_VERIFIED: "EMAIL_ALREADY_VERIFIED",
  EMAIL_MISMATCH: "EMAIL_MISMATCH",
  SESSION_NOT_FRESH: "SESSION_NOT_FRESH",
  LINKED_ACCOUNT_ALREADY_EXISTS: "LINKED_ACCOUNT_ALREADY_EXISTS",
  INVALID_ORIGIN: "INVALID_ORIGIN",
  INVALID_CALLBACK_URL: "INVALID_CALLBACK_URL",
  INVALID_REDIRECT_URL: "INVALID_REDIRECT_URL",
  INVALID_ERROR_CALLBACK_URL: "INVALID_ERROR_CALLBACK_URL",
  INVALID_NEW_USER_CALLBACK_URL: "INVALID_NEW_USER_CALLBACK_URL",
  MISSING_OR_NULL_ORIGIN: "MISSING_OR_NULL_ORIGIN",
  FAILED_TO_CREATE_VERIFICATION: "FAILED_TO_CREATE_VERIFICATION",
  VALIDATION_ERROR: "VALIDATION_ERROR",
  MISSING_FIELD: "MISSING_FIELD",
  PASSWORD_ALREADY_SET: "PASSWORD_ALREADY_SET",
  // admin plugin
  BANNED_USER: "BANNED_USER",
  // two-factor plugin
  TWO_FACTOR_NOT_ENABLED: "TWO_FACTOR_NOT_ENABLED",
  TOTP_NOT_ENABLED: "TOTP_NOT_ENABLED",
  BACKUP_CODES_NOT_ENABLED: "BACKUP_CODES_NOT_ENABLED",
  INVALID_CODE: "INVALID_CODE",
  INVALID_BACKUP_CODE: "INVALID_BACKUP_CODE",
  INVALID_TWO_FACTOR_COOKIE: "INVALID_TWO_FACTOR_COOKIE",
  TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE: "TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE",
  ACCOUNT_TEMPORARILY_LOCKED: "ACCOUNT_TEMPORARILY_LOCKED",
  // have-i-been-pwned plugin
  PASSWORD_COMPROMISED: "PASSWORD_COMPROMISED",
  // ours
  SSO_REQUIRED: "SSO_REQUIRED",
  SSO_PROVIDER_MISCONFIGURED: "SSO_PROVIDER_MISCONFIGURED",
  SSO_PROVIDER_UNREACHABLE: "SSO_PROVIDER_UNREACHABLE",
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

/**
 * Narrow an arbitrary string to a code we have copy for.
 *
 * Better Auth is not the only thing that can put a `code` on the wire — the
 * edge limiter and our own routes answer `{ error, code }` too — so this is the
 * boundary where "looks like a code" becomes "is a code".
 */
export function isAuthErrorCode(value: unknown): value is AuthErrorCode {
  return typeof value === "string" && KNOWN_CODES.has(value.toUpperCase());
}

/**
 * Same, but tolerant of casing and surrounding whitespace — Better Auth
 * upper-cases its own codes, but a hand-written `Refusal` might not.
 */
export function normalizeAuthErrorCode(
  value: string | null | undefined,
): AuthErrorCode | null {
  if (!value) return null;
  const upper = value.trim().toUpperCase();
  return KNOWN_CODES.has(upper) ? (upper as AuthErrorCode) : null;
}
