import { captcha } from "better-auth/plugins";
import { reportSentryMessage } from "@/lib/observability/report";
import type { RuntimeEnv } from "@/lib/request-ip";

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
 * checks). Production without both keys boots with one loud warning.
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
    reportSentryMessage("AUTH_CAPTCHA_DISABLED", {
      subsystem: "auth",
      op: "captcha.boot",
      level: "warning",
      extra: { missing },
    });
  }
  return [];
}

/**
 * The hostname a production token must have been minted on. The plugin
 * matches exactly, so per-PR preview hostnames (and Cloudflare's test keys,
 * which report example.com) get no hostname check.
 */
export function turnstileHostnames(env: RuntimeEnv): string[] | undefined {
  if (env.CONTEXT !== "production" || !env.BETTER_AUTH_URL) return undefined;
  try {
    return [new URL(env.BETTER_AUTH_URL).hostname];
  } catch {
    return undefined;
  }
}
