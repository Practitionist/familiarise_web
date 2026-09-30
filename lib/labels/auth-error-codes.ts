/**
 * The closed set of codes this app is willing to turn into a sentence.
 *
 * Two sources, deliberately kept apart:
 *
 *   - `BetterAuthErrorCode` — the codes Better Auth itself can return. Read off
 *     `@better-auth/core`'s `BASE_ERROR_CODES` plus the `admin`, `organization`,
 *     `two-factor` and `captcha` plugin tables. NOT hand-invented: each entry
 *     below is a literal that appears in the installed package, so a typo here
 *     cannot silently become an unreachable branch.
 *
 *   - `AppAuthErrorCode` — codes this codebase mints itself: the SSO veto in
 *     `lib/auth.ts`'s `session.create.before`, the edge rate limiter, the
 *     session-lookup tri-state, the captcha gate, the account lockout, and the
 *     B2C entitlement layer.
 *
 * Why the union is closed: `lib/labels/auth-errors.catalog.ts` is a
 * `Record<AuthErrorCode, AuthErrorCopy>`. Adding a code to either half makes
 * that record fail to compile until it also has copy. A Better Auth upgrade
 * that introduces a new code therefore surfaces as a **build failure**, not as
 * a customer staring at "Something went wrong on our side".
 *
 * That inversion is the whole point. The previous catalog was
 * `Record<string, AuthErrorCopy>`, which silently accepted every unhandled code
 * and fell through to a generic sentence — so every code Better Auth ever
 * added became a support ticket nobody could diagnose.
 */

/* -------------------------------------------------------------------------- */
/* Better Auth                                                                */
/* -------------------------------------------------------------------------- */

/**
 * `@better-auth/core` `BASE_ERROR_CODES`.
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
  | "ID_TOKEN_NOT_SUPPORTED"
  | "FAILED_TO_GET_USER_INFO"
  | "USER_EMAIL_NOT_FOUND"
  | "EMAIL_NOT_VERIFIED"
  | "PASSWORD_TOO_SHORT"
  | "PASSWORD_TOO_LONG"
  | "USER_ALREADY_EXISTS"
  | "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL"
  | "EMAIL_CAN_NOT_BE_UPDATED"
  | "CREDENTIAL_ACCOUNT_NOT_FOUND"
  | "SESSION_EXPIRED"
  | "FAILED_TO_UNLINK_LAST_ACCOUNT"
  | "ACCOUNT_NOT_FOUND"
  | "USER_ALREADY_HAS_PASSWORD"
  | "CROSS_SITE_NAVIGATION_LOGIN_BLOCKED"
  | "VERIFICATION_EMAIL_NOT_ENABLED"
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
  | "CALLBACK_URL_REQUIRED"
  | "FAILED_TO_CREATE_VERIFICATION"
  | "FIELD_NOT_ALLOWED"
  | "ASYNC_VALIDATION_NOT_SUPPORTED"
  | "VALIDATION_ERROR"
  | "MISSING_FIELD"
  | "METHOD_NOT_ALLOWED_DEFER_SESSION_REQUIRED"
  | "BODY_MUST_BE_AN_OBJECT"
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
 * `organization` plugin, narrowed to the two the invite-accept path surfaces.
 * The rest are authorisation refusals that `lib/labels/org-errors.ts` owns.
 * @see node_modules/better-auth/dist/plugins/organization/error-codes.mjs
 */
export type OrganizationPluginErrorCode =
  | "INVITATION_NOT_FOUND"
  | "YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION"
  | "USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION";

/**
 * `two-factor` plugin.
 * @see node_modules/better-auth/dist/plugins/two-factor/error-code.mjs
 */
export type TwoFactorPluginErrorCode =
  | "TWO_FACTOR_NOT_ENABLED"
  | "TWO_FACTOR_PLUGIN_DISABLED"
  | "TOTP_NOT_ENABLED"
  | "OTP_NOT_ENABLED"
  | "BACKUP_CODES_NOT_ENABLED"
  | "INVALID_CODE"
  | "INVALID_BACKUP_CODE"
  | "INVALID_TWO_FACTOR_COOKIE"
  | "OTP_HAS_EXPIRED"
  | "TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE";

/**
 * `captcha` plugin, external half.
 * @see node_modules/better-auth/dist/plugins/captcha/error-codes.mjs
 */
export type CaptchaPluginErrorCode =
  | "VERIFICATION_FAILED"
  | "MISSING_RESPONSE"
  | "CAPTCHA_SERVICE_UNAVAILABLE";

export type BetterAuthErrorCode =
  | BetterAuthCoreErrorCode
  | AdminPluginErrorCode
  | OrganizationPluginErrorCode
  | TwoFactorPluginErrorCode
  | CaptchaPluginErrorCode;

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
  /* lib/auth/attempts.ts — graduated per-account lockout after repeat failures. */
  | "ACCOUNT_TEMPORARILY_LOCKED"
  /* lib/auth-session-lookup.ts — the lookup threw; it did not answer "no". */
  | "SESSION_LOOKUP_FAILED"
  /* The request never reached Better Auth: origin/CORS/CSRF at the edge. */
  | "REQUEST_REJECTED"
  /* Server-enrolled 2FA that the client has not satisfied yet. */
  | "TWO_FACTOR_REQUIRED"
  /* lib/entitlements/ — B2C plan gates. */
  | "PLAN_FEATURE_NOT_INCLUDED"
  | "PLAN_LIMIT_REACHED"
  /* Staff/admin onboarding. */
  | "INVITATION_EXPIRED"
  | "INVITATION_ALREADY_ACCEPTED"
  | "INVITATION_NOT_FOR_YOU"
  /* lib/auth/staff-invitations.ts — a staff invite somebody withdrew. Kept
     distinct from EXPIRED because nobody chose it, and from NOT_FOUND because
     saying "not found" about a link a customer holds is how they learn the
     difference between a typo and a revocation. */
  | "INVITATION_REVOKED"
  | "SETUP_TOKEN_INVALID"
  | "SETUP_TOKEN_EXPIRED"
  | "SETUP_TOKEN_ALREADY_USED"
  /* lib/auth-helpers.ts — impersonation blocks a privileged action. */
  | "IMPERSONATION_BLOCKED";

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
  ID_TOKEN_NOT_SUPPORTED: "ID_TOKEN_NOT_SUPPORTED",
  FAILED_TO_GET_USER_INFO: "FAILED_TO_GET_USER_INFO",
  USER_EMAIL_NOT_FOUND: "USER_EMAIL_NOT_FOUND",
  EMAIL_NOT_VERIFIED: "EMAIL_NOT_VERIFIED",
  PASSWORD_TOO_SHORT: "PASSWORD_TOO_SHORT",
  PASSWORD_TOO_LONG: "PASSWORD_TOO_LONG",
  USER_ALREADY_EXISTS: "USER_ALREADY_EXISTS",
  USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL",
  EMAIL_CAN_NOT_BE_UPDATED: "EMAIL_CAN_NOT_BE_UPDATED",
  CREDENTIAL_ACCOUNT_NOT_FOUND: "CREDENTIAL_ACCOUNT_NOT_FOUND",
  SESSION_EXPIRED: "SESSION_EXPIRED",
  FAILED_TO_UNLINK_LAST_ACCOUNT: "FAILED_TO_UNLINK_LAST_ACCOUNT",
  ACCOUNT_NOT_FOUND: "ACCOUNT_NOT_FOUND",
  USER_ALREADY_HAS_PASSWORD: "USER_ALREADY_HAS_PASSWORD",
  CROSS_SITE_NAVIGATION_LOGIN_BLOCKED: "CROSS_SITE_NAVIGATION_LOGIN_BLOCKED",
  VERIFICATION_EMAIL_NOT_ENABLED: "VERIFICATION_EMAIL_NOT_ENABLED",
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
  CALLBACK_URL_REQUIRED: "CALLBACK_URL_REQUIRED",
  FAILED_TO_CREATE_VERIFICATION: "FAILED_TO_CREATE_VERIFICATION",
  FIELD_NOT_ALLOWED: "FIELD_NOT_ALLOWED",
  ASYNC_VALIDATION_NOT_SUPPORTED: "ASYNC_VALIDATION_NOT_SUPPORTED",
  VALIDATION_ERROR: "VALIDATION_ERROR",
  MISSING_FIELD: "MISSING_FIELD",
  METHOD_NOT_ALLOWED_DEFER_SESSION_REQUIRED:
    "METHOD_NOT_ALLOWED_DEFER_SESSION_REQUIRED",
  BODY_MUST_BE_AN_OBJECT: "BODY_MUST_BE_AN_OBJECT",
  PASSWORD_ALREADY_SET: "PASSWORD_ALREADY_SET",
  // admin plugin
  BANNED_USER: "BANNED_USER",
  // organization plugin
  INVITATION_NOT_FOUND: "INVITATION_NOT_FOUND",
  YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION:
    "YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION",
  USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION:
    "USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION",
  // two-factor plugin
  TWO_FACTOR_NOT_ENABLED: "TWO_FACTOR_NOT_ENABLED",
  TWO_FACTOR_PLUGIN_DISABLED: "TWO_FACTOR_PLUGIN_DISABLED",
  TOTP_NOT_ENABLED: "TOTP_NOT_ENABLED",
  OTP_NOT_ENABLED: "OTP_NOT_ENABLED",
  BACKUP_CODES_NOT_ENABLED: "BACKUP_CODES_NOT_ENABLED",
  INVALID_CODE: "INVALID_CODE",
  INVALID_BACKUP_CODE: "INVALID_BACKUP_CODE",
  INVALID_TWO_FACTOR_COOKIE: "INVALID_TWO_FACTOR_COOKIE",
  OTP_HAS_EXPIRED: "OTP_HAS_EXPIRED",
  TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE: "TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE",
  // captcha plugin
  VERIFICATION_FAILED: "VERIFICATION_FAILED",
  MISSING_RESPONSE: "MISSING_RESPONSE",
  CAPTCHA_SERVICE_UNAVAILABLE: "CAPTCHA_SERVICE_UNAVAILABLE",
  // ours
  SSO_REQUIRED: "SSO_REQUIRED",
  SSO_PROVIDER_MISCONFIGURED: "SSO_PROVIDER_MISCONFIGURED",
  SSO_PROVIDER_UNREACHABLE: "SSO_PROVIDER_UNREACHABLE",
  RATE_LIMITED: "RATE_LIMITED",
  ACCOUNT_TEMPORARILY_LOCKED: "ACCOUNT_TEMPORARILY_LOCKED",
  SESSION_LOOKUP_FAILED: "SESSION_LOOKUP_FAILED",
  REQUEST_REJECTED: "REQUEST_REJECTED",
  TWO_FACTOR_REQUIRED: "TWO_FACTOR_REQUIRED",
  PLAN_FEATURE_NOT_INCLUDED: "PLAN_FEATURE_NOT_INCLUDED",
  PLAN_LIMIT_REACHED: "PLAN_LIMIT_REACHED",
  INVITATION_EXPIRED: "INVITATION_EXPIRED",
  INVITATION_ALREADY_ACCEPTED: "INVITATION_ALREADY_ACCEPTED",
  INVITATION_NOT_FOR_YOU: "INVITATION_NOT_FOR_YOU",
  INVITATION_REVOKED: "INVITATION_REVOKED",
  SETUP_TOKEN_INVALID: "SETUP_TOKEN_INVALID",
  SETUP_TOKEN_EXPIRED: "SETUP_TOKEN_EXPIRED",
  SETUP_TOKEN_ALREADY_USED: "SETUP_TOKEN_ALREADY_USED",
  IMPERSONATION_BLOCKED: "IMPERSONATION_BLOCKED",
} as const satisfies Record<AuthErrorCode, AuthErrorCode>;

const KNOWN_CODES: ReadonlySet<string> = new Set(Object.values(AUTH_ERROR_CODES));

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
