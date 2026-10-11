/**
 * BetterAuth's rate limiter for `/api/auth/*`, stored in Upstash.
 *
 * BetterAuth keys every request on `${clientIp}|${path}` and asks the store to
 * `consume(key, rule)` before the endpoint runs. The default store is
 * per-process memory, which on Netlify means one counter per warm lambda; the
 * count has to live in Redis to mean anything. Running the limiter inside
 * BetterAuth (rather than at the edge) also covers every plugin path, including
 * `/two-factor/*`, and matches the router's own path normalisation.
 */

import { createHash } from "crypto";
import type { BetterAuthRateLimitOptions } from "better-auth";
import { captureThrottled } from "@/lib/observability/throttled-capture";

type RateLimitStorage = NonNullable<
  BetterAuthRateLimitOptions["customStorage"]
>;
type RateLimitRule = { window: number; max: number };

/** The subset of the Upstash client (and `lib/redis-mock`) this store uses. */
export interface RateLimitRedis {
  eval(script: string, keys: string[], args: string[]): Promise<unknown>;
  pttl(key: string): Promise<number>;
}

// INCR and the first-hit PEXPIRE run as one script, so a counter can never be
// left without a TTL (which would block its key for good) and concurrent
// requests cannot both pass on a stale read.
const CONSUME_SCRIPT = `
local count = redis.call("INCR", KEYS[1])
if count == 1 then
redis.call("PEXPIRE", KEYS[1], ARGV[1])
end
return count
`;

// A slow Upstash must not stall sign-in; past this the request is let through.
const STORE_TIMEOUT_MS = 500;

const LOOPBACK = new Set(["127.0.0.1", "::1"]);

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`rate-limit store timed out after ${ms}ms`)),
      ms,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * A fixed-window counter per key. Fails open: a Redis outage must not lock
 * every user out of signing in, so an error or timeout allows the request and
 * is reported once a minute per instance (an outage fails every call at once).
 */
export function createUpstashRateLimitStorage(
  getRedis: () => Promise<RateLimitRedis>,
): RateLimitStorage {
  return {
    async consume(key: string, rule: RateLimitRule) {
      // Local dev and e2e runs share one loopback address; production never
      // skips (BetterAuth only falls back to 127.0.0.1 outside production).
      const ip = key.slice(0, key.indexOf("|"));
      if (process.env.NODE_ENV !== "production" && LOOPBACK.has(ip)) {
        return { allowed: true, retryAfter: null };
      }

      // Hashed: the path can carry a bearer secret (`/reset-password/:token`)
      // and Redis keys are plaintext at rest.
      const redisKey = `rl:ba:${createHash("sha256").update(key).digest("hex")}`;
      try {
        const redis = await getRedis();
        const count = Number(
          await withTimeout(
            redis.eval(
              CONSUME_SCRIPT,
              [redisKey],
              [String(rule.window * 1000)],
            ),
            STORE_TIMEOUT_MS,
          ),
        );
        if (count <= rule.max) return { allowed: true, retryAfter: null };
        const ttlMs = await withTimeout(redis.pttl(redisKey), STORE_TIMEOUT_MS);
        return {
          allowed: false,
          retryAfter: ttlMs > 0 ? Math.ceil(ttlMs / 1000) : rule.window,
        };
      } catch (error) {
        captureThrottled("auth:rate-limit-store", error, {
          subsystem: "auth",
          op: "rate-limit-consume",
          expected: false,
        });
        return { allowed: true, retryAfter: null };
      }
    },
  };
}

const MINUTE = 60;
const HOUR = 60 * MINUTE;

/**
 * Per-path budgets, in seconds, keyed per client IP and path. Keys are
 * BetterAuth paths without `/api/auth`; `*` matches one path segment. The
 * first matching key wins, so specific patterns come before broader ones.
 * Unlisted paths get the 100/min default below.
 */
export const AUTH_RATE_LIMIT_RULES: NonNullable<
  BetterAuthRateLimitOptions["customRules"]
> = {
  // Credential guessing surfaces. Generous enough for typos and a Caps Lock
  // discovery, far below a scripted sweep.
  "/sign-in/email": { window: 15 * MINUTE, max: 30 },
  "/change-password": { window: 15 * MINUTE, max: 5 },
  "/verify-password": { window: 15 * MINUTE, max: 5 },
  // Second factor. The twoFactor plugin also locks the account after 10
  // consecutive failures for 15 minutes, whichever IP they come from.
  "/two-factor/verify-*": { window: MINUTE, max: 5 },
  "/two-factor/*": { window: MINUTE, max: 10 },
  // Passkey sign-in is a full credential; management is a handful of clicks.
  "/passkey/verify-authentication": { window: 15 * MINUTE, max: 30 },
  "/passkey/*": { window: MINUTE, max: 20 },

  // Account creation and the mail-sending endpoints: each call costs sending
  // reputation and can be aimed at anyone's inbox. One household or office
  // NAT still fits a few sign-ups and resets an hour.
  "/sign-up/email": { window: HOUR, max: 5 },
  "/request-password-reset": { window: HOUR, max: 3 },
  "/email-otp/send-verification-otp": { window: HOUR, max: 5 },

  // Single-use tokens. The GET form carries the token in the path, so its
  // bucket is per token as well as per IP. A verification code also locks
  // after 5 wrong tries (emailOTP allowedAttempts), whichever IP sent them.
  "/reset-password": { window: HOUR, max: 20 },
  "/reset-password/*": { window: HOUR, max: 10 },
  "/email-otp/verify-email": { window: 15 * MINUTE, max: 10 },

  // Delegated sign-in. Users on flaky connections retry the IdP round trip,
  // and a 429 here reads as "Google sign-in is broken", so these stay loose.
  "/sign-in/social": { window: 15 * MINUTE, max: 30 },
  "/callback/*": { window: 15 * MINUTE, max: 30 },
  // Enforce-on signs a whole office out at once behind one NAT address, and
  // the callback's state and PKCE are single-use, so these only stop floods.
  "/sign-in/sso": { window: 15 * MINUTE, max: 300 },
  "/sso/callback/*": { window: 15 * MINUTE, max: 1000 },

  // Read on every page load and tab focus, and nothing to guess. Throttling
  // sign-out would strand a user on a device they are trying to leave.
  "/get-session": false,
  "/sign-out": false,
};

export const authRateLimit: BetterAuthRateLimitOptions = {
  // BetterAuth only enables the limiter in production by default; stated so
  // preview and staging deploys are covered regardless of NODE_ENV.
  enabled: true,
  window: MINUTE,
  max: 100,
  customRules: AUTH_RATE_LIMIT_RULES,
  // Imported lazily so a missing Upstash env fails one limiter check (open)
  // instead of the whole auth module at load.
  customStorage: createUpstashRateLimitStorage(
    async () => (await import("@/lib/redis")).default,
  ),
};

/**
 * BetterAuth's 429 carries only `X-Retry-After`. Mirror it into the standard
 * `Retry-After` so browsers, proxies and our own clients back off by it.
 */
export function withRetryAfter(response: Response): Response {
  if (response.status !== 429 || response.headers.has("Retry-After")) {
    return response;
  }
  const retryAfter = response.headers.get("X-Retry-After");
  if (!retryAfter) return response;
  const headers = new Headers(response.headers);
  headers.set("Retry-After", retryAfter);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
