import { captcha } from "better-auth/plugins";
import * as Sentry from "@sentry/nextjs";

/**
 * The endpoints that send mail to an address the caller types in. Sign-in is
 * left out on purpose: it sends nothing until the password has matched.
 */
export const CAPTCHA_PROTECTED_PATHS = [
  "/sign-up/email",
  "/request-password-reset",
  "/email-otp/send-verification-otp",
];

/** Cloudflare's published test keys (developers.cloudflare.com/turnstile/troubleshooting/testing/). */
const TURNSTILE_DUMMY_SITE_KEYS: ReadonlySet<string> = new Set([
  "1x00000000000000000000AA",
  "2x00000000000000000000AB",
  "1x00000000000000000000BB",
  "2x00000000000000000000BB",
  "3x00000000000000000000FF",
]);
const TURNSTILE_DUMMY_SECRET_KEYS: ReadonlySet<string> = new Set([
  "1x0000000000000000000000000000000AA",
  "2x0000000000000000000000000000000AA",
  "3x0000000000000000000000000000000AA",
]);
/** The test secret whose siteverify always answers `success: false`. */
export const TURNSTILE_ALWAYS_FAIL_SECRET =
  "2x0000000000000000000000000000000AA";

export function isTurnstileDummyKey(key: string | undefined): boolean {
  const trimmed = key?.trim() ?? "";
  return (
    TURNSTILE_DUMMY_SITE_KEYS.has(trimmed) ||
    TURNSTILE_DUMMY_SECRET_KEYS.has(trimmed)
  );
}

/**
 * Cloudflare Turnstile on the mail-sending endpoints, or nothing when either
 * key is unset (the browser needs the site key to mint the token the server
 * checks). Production without both keys boots with one loud log line.
 * Production with a test key keeps the plugin but verifies with the
 * always-fail secret, so those endpoints refuse instead of passing every bot.
 */
export function turnstileCaptcha(keys: {
  secretKey: string | undefined;
  siteKey: string | undefined;
  allowedHostnames?: string[];
  sentryEnvironment?: string;
}) {
  const secretKey = keys.secretKey?.trim();
  const siteKey = keys.siteKey?.trim();
  if (secretKey && siteKey) {
    const testKeys = [
      ...(isTurnstileDummyKey(secretKey) ? ["TURNSTILE_SECRET_KEY"] : []),
      ...(isTurnstileDummyKey(siteKey)
        ? ["NEXT_PUBLIC_TURNSTILE_SITE_KEY"]
        : []),
    ];
    const refuseTestKeys =
      keys.sentryEnvironment === "production" && testKeys.length > 0;
    if (refuseTestKeys) reportTestKeysInProduction(testKeys);
    return [
      captcha({
        provider: "cloudflare-turnstile",
        secretKey: refuseTestKeys ? TURNSTILE_ALWAYS_FAIL_SECRET : secretKey,
        endpoints: CAPTCHA_PROTECTED_PATHS,
        allowedHostnames: keys.allowedHostnames,
      }),
    ];
  }
  if (
    process.env.NODE_ENV === "production" &&
    process.env.NEXT_PHASE !== "phase-production-build"
  ) {
    const missing = [
      ...(secretKey ? [] : ["TURNSTILE_SECRET_KEY"]),
      ...(siteKey ? [] : ["NEXT_PUBLIC_TURNSTILE_SITE_KEY"]),
    ];
    console.error(
      `[auth] Turnstile is off: ${missing.join(" and ")} unset. Sign-up, password reset and code resend run without a captcha.`,
    );
    // A log, not an issue event: it fires on every cold start, and Sentry Logs
    // do not draw on the error quota.
    Sentry.logger.warn("AUTH_CAPTCHA_DISABLED", { missing: missing.join(",") });
  }
  return [];
}

function reportTestKeysInProduction(testKeys: string[]): void {
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  console.error(
    `[auth] Turnstile refuses: a Cloudflare test key is in ${testKeys.join(" and ")} on production. Sign-up, password reset and code resend fail until the real keys are set.`,
  );
  Sentry.logger.warn("AUTH_CAPTCHA_TEST_KEYS_IN_PRODUCTION", {
    keys: testKeys.join(","),
  });
}

/**
 * The hostname a production token must have been minted on. Production is
 * read from the build-inlined Sentry environment, because Netlify's CONTEXT
 * is build-time only. The plugin matches exactly, so per-PR preview
 * hostnames get none.
 */
export function turnstileHostnames(env: {
  sentryEnvironment: string | undefined;
  authUrl: string | undefined;
}): string[] | undefined {
  if (env.sentryEnvironment !== "production" || !env.authUrl) return undefined;
  try {
    return [new URL(env.authUrl).hostname];
  } catch {
    return undefined;
  }
}
