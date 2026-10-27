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

/**
 * Cloudflare Turnstile on the mail-sending endpoints, or nothing when either
 * key is unset (the browser needs the site key to mint the token the server
 * checks). Production without both keys boots with one loud log line.
 */
export function turnstileCaptcha(keys: {
  secretKey: string | undefined;
  siteKey: string | undefined;
  allowedHostnames?: string[];
}) {
  const secretKey = keys.secretKey?.trim();
  const siteKey = keys.siteKey?.trim();
  if (secretKey && siteKey) {
    return [
      captcha({
        provider: "cloudflare-turnstile",
        secretKey,
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

/**
 * The hostname a production token must have been minted on. Production is
 * read from the build-inlined Sentry environment, because Netlify's CONTEXT
 * is build-time only. The plugin matches exactly, so per-PR preview
 * hostnames (and Cloudflare's test keys, which report example.com) get none.
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
