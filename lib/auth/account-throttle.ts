import { createHash } from "node:crypto";
import type { BetterAuthPlugin } from "better-auth";
import { createAuthMiddleware, isAPIError } from "better-auth/api";
import { z } from "zod";
import { captureThrottled } from "@/lib/observability/throttled-capture";
import {
  CONSUME_SCRIPT,
  STORE_TIMEOUT_MS,
  withTimeout,
} from "@/lib/auth/rate-limit";

const SIGN_IN_PATH = "/sign-in/email";
const FAILURE_WINDOW_MS = 15 * 60 * 1000;

/** Wrong passwords for one address in the window → seconds the next try waits. */
export const SIGN_IN_THROTTLE_TIERS = [
  { failures: 40, waitSeconds: 15 * 60 },
  { failures: 20, waitSeconds: 2 * 60 },
  { failures: 10, waitSeconds: 30 },
] as const;

/** The subset of the Upstash client (and `lib/redis-mock`) this throttle uses. */
export interface AccountThrottleRedis {
  eval(script: string, keys: string[], args: string[]): Promise<unknown>;
  pttl(key: string): Promise<number>;
  set(key: string, value: string, opts: { px: number }): Promise<unknown>;
  del(...keys: string[]): Promise<number>;
}

const SignInBodySchema = z.object({ email: z.string().min(1) });

export function signInWaitSeconds(failures: number): number {
  return (
    SIGN_IN_THROTTLE_TIERS.find((tier) => failures >= tier.failures)
      ?.waitSeconds ?? 0
  );
}

// Hashed: Redis is plaintext at rest. Keyed on the submitted address whether
// or not an account exists, so the 429 says nothing about who is registered.
function keysFor(email: string): { count: string; lock: string } {
  const digest = createHash("sha256")
    .update(email.trim().toLowerCase())
    .digest("hex");
  return {
    count: `rl:acct:signin:${digest}`,
    lock: `rl:acct:signin:lock:${digest}`,
  };
}

/** Byte-for-byte BetterAuth's own per-IP 429, so the two cannot be told apart. */
function tooManyRequests(retryAfterSeconds: number): Response {
  return new Response(
    JSON.stringify({ message: "Too many requests. Please try again later." }),
    {
      status: 429,
      statusText: "Too Many Requests",
      headers: {
        "Content-Type": "application/json",
        "X-Retry-After": String(retryAfterSeconds),
      },
    },
  );
}

async function submittedEmail(request: Request): Promise<string | null> {
  try {
    const body = SignInBodySchema.safeParse(await request.clone().json());
    return body.success ? body.data.email : null;
  } catch {
    return null;
  }
}

/**
 * Soft per-account throttle on password sign-in: growing `Retry-After`
 * windows, never a lockout. Fails open when Redis is slow or down.
 */
export function createSignInThrottle(
  getRedis: () => Promise<AccountThrottleRedis>,
) {
  async function withRedis<T>(
    run: (redis: AccountThrottleRedis) => Promise<T>,
    fallback: T,
  ): Promise<T> {
    try {
      return await withTimeout(run(await getRedis()), STORE_TIMEOUT_MS);
    } catch (error) {
      captureThrottled("auth:account-throttle", error, {
        subsystem: "auth",
        op: "account-throttle",
        level: "warning",
      });
      return fallback;
    }
  }

  async function retryAfterSeconds(email: string): Promise<number | null> {
    const ttlMs = await withRedis(
      (redis) => redis.pttl(keysFor(email).lock),
      -2,
    );
    return ttlMs > 0 ? Math.ceil(ttlMs / 1000) : null;
  }

  async function recordFailure(email: string): Promise<void> {
    const keys = keysFor(email);
    await withRedis(async (redis) => {
      const failures = Number(
        await redis.eval(
          CONSUME_SCRIPT,
          [keys.count],
          [String(FAILURE_WINDOW_MS)],
        ),
      );
      const wait = signInWaitSeconds(failures);
      if (wait > 0) await redis.set(keys.lock, "1", { px: wait * 1000 });
    }, undefined);
  }

  /** A successful sign-in or a completed password reset starts the count over. */
  async function clear(email: string): Promise<void> {
    const keys = keysFor(email);
    await withRedis((redis) => redis.del(keys.count, keys.lock), 0);
  }

  const plugin = {
    id: "account-sign-in-throttle",
    // HTTP only: runs before the password is hashed or compared.
    onRequest: async (request, ctx) => {
      if (request.method !== "POST") return;
      const basePath = ctx.options.basePath ?? "/api/auth";
      if (new URL(request.url).pathname !== `${basePath}${SIGN_IN_PATH}`) {
        return;
      }
      const email = await submittedEmail(request);
      if (!email) return;
      const wait = await retryAfterSeconds(email);
      return wait === null ? undefined : { response: tooManyRequests(wait) };
    },
    hooks: {
      after: [
        {
          matcher: (ctx) => ctx.path === SIGN_IN_PATH,
          handler: createAuthMiddleware(async (ctx) => {
            const body = SignInBodySchema.safeParse(ctx.body);
            if (!body.success) return;
            const returned = ctx.context.returned;
            if (isAPIError(returned)) {
              if (returned.body?.code === "INVALID_EMAIL_OR_PASSWORD") {
                await recordFailure(body.data.email);
              }
              return;
            }
            if (returned instanceof Error) return;
            // A session, or a pending 2FA challenge: the password matched.
            await clear(body.data.email);
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin;

  return { plugin, clear, recordFailure };
}

export const signInThrottle = createSignInThrottle(
  async () => (await import("@/lib/redis")).default,
);
