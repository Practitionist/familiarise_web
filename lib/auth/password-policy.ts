import { createHash } from "node:crypto";
import type { BetterAuthPlugin } from "better-auth";
import { APIError } from "better-auth/api";
import { tryGetCurrentAuthEndpointContext } from "@better-auth/core/context";
import { captureThrottled } from "@/lib/observability/throttled-capture";

/**
 * Where a user picks a password. Admin create-user is left out on purpose:
 * staff are created with a random 32-byte password nobody sees, so checking
 * it would only make onboarding depend on the range API.
 */
const CHECKED_PATHS = ["/sign-up/email", "/change-password", "/reset-password"];
const TIMEOUT_MS = 2000;

const ERROR_CODES = {
  PASSWORD_COMPROMISED: {
    code: "PASSWORD_COMPROMISED",
    // The UI never shows this (lib/labels renders PASSWORD_COMPROMISED); it
    // is for API clients.
    message:
      "This password has appeared in a data breach. Choose a different password.",
  },
} as const;

/** Breach count for `password`; only a 5-hex SHA-1 prefix leaves the server. */
async function breachCount(password: string): Promise<number> {
  const sha1 = createHash("sha1").update(password).digest("hex").toUpperCase();
  const response = await fetch(
    `https://api.pwnedpasswords.com/range/${sha1.slice(0, 5)}`,
    {
      headers: { "Add-Padding": "true" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    },
  );
  if (!response.ok) throw new Error(`HIBP range API: ${response.status}`);
  const suffix = sha1.slice(5);
  for (const line of (await response.text()).split("\n")) {
    const [hash, count] = line.trim().split(":");
    if (hash === suffix) return Number(count) || 0;
  }
  return 0;
}

/**
 * Rejects passwords found in the Have I Been Pwned corpus on the paths above.
 * Replaces BetterAuth's `haveIBeenPwned` plugin, which fails closed: an HIBP
 * outage would block every sign-up and reset. This one fails open, because
 * the check is a hygiene layer, not authentication, and reports the outage to
 * Sentry (throttled, since one outage hits every request).
 */
export const breachedPasswordCheck = {
  id: "breached-password-check",
  init(ctx) {
    const hash = ctx.password.hash;
    return {
      context: {
        password: {
          ...ctx.password,
          async hash(password: string) {
            const path = tryGetCurrentAuthEndpointContext()?.path;
            if (path && CHECKED_PATHS.includes(path)) {
              let count = 0;
              try {
                count = await breachCount(password);
              } catch (error) {
                captureThrottled("auth:hibp", error, {
                  subsystem: "auth",
                  op: "hibp-range",
                  level: "warning",
                });
              }
              if (count > 0) {
                throw new APIError("BAD_REQUEST", {
                  ...ERROR_CODES.PASSWORD_COMPROMISED,
                });
              }
            }
            return hash(password);
          },
        },
      },
    };
  },
  $ERROR_CODES: ERROR_CODES,
} satisfies BetterAuthPlugin;
