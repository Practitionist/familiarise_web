import { createHash } from "node:crypto";
import type { BetterAuthPlugin } from "better-auth";
import { createAuthMiddleware, isAPIError } from "better-auth/api";
import { normalizeIP } from "@better-auth/core/utils/ip";
import { z } from "zod";
import { captureThrottled } from "@/lib/observability/throttled-capture";
import {
  CONSUME_SCRIPT,
  STORE_TIMEOUT_MS,
  withTimeout,
} from "@/lib/auth/rate-limit";
import { clientIpFrom } from "@/lib/request-ip";

const SIGN_IN_PATH = "/sign-in/email";
const FAILURE_WINDOW_MS = 15 * 60 * 1000;

/**
 * Wrong passwords for one address in the window → seconds the next try waits.
 * Per address from anywhere the wait stays short, so a stranger cannot lock a
 * victim out; the long wait applies only to the network prefix doing the guessing.
 */
export const ACCOUNT_TIERS = [
  { failures: 20, waitSeconds: 2 * 60 },
  { failures: 10, waitSeconds: 30 },
] as const;
export const PREFIX_TIERS = [{ failures: 40, waitSeconds: 15 * 60 }] as const;

/** The subset of the Upstash client (and `lib/redis-mock`) this throttle uses. */
export interface AccountThrottleRedis {
  eval(script: string, keys: string[], args: string[]): Promise<unknown>;
  pttl(key: string): Promise<number>;
  set(key: string, value: string, opts: { px: number }): Promise<unknown>;
  del(...keys: string[]): Promise<number>;
}

const SignInBodySchema = z.object({ email: z.string().min(1) });

type Tier = { failures: number; waitSeconds: number };

export function waitSecondsFor(
  tiers: readonly Tier[],
  failures: number,
): number {
  return tiers.find((tier) => failures >= tier.failures)?.waitSeconds ?? 0;
}

/** The client's /24 (IPv4) or /48 (IPv6), from the header this runtime trusts. */
export function networkPrefix(headers: Headers | undefined): string {
  if (!headers) return "unknown_ip";
  const ip = normalizeIP(clientIpFrom(headers), { ipv6Subnet: 48 });
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(ip)
    ? `${ip.split(".").slice(0, 3).join(".")}.0/24`
    : ip;
}

// Hashed: Redis is plaintext at rest. Keyed on the submitted address whether
// or not an account exists, so the 429 says nothing about who is registered.
function keysFor(email: string, prefix: string) {
  const address = email.trim().toLowerCase();
  const account = createHash("sha256").update(address).digest("hex");
  const scoped = createHash("sha256")
    .update(`${address}|${prefix}`)
    .digest("hex");
  return {
    account: {
      count: `rl:acct:signin:${account}`,
      lock: `rl:acct:signin:lock:${account}`,
    },
    prefix: {
      count: `rl:acct:signin:net:${scoped}`,
      lock: `rl:acct:signin:net:lock:${scoped}`,
    },
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

/**
 * Soft throttle on password sign-in: growing `Retry-After` windows, never a
 * lockout a stranger can hold. Fails open when Redis is slow or down.
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

  async function retryAfterSeconds(
    email: string,
    prefix: string,
  ): Promise<number | null> {
    const keys = keysFor(email, prefix);
    const ttlMs = await withRedis(
      async (redis) =>
        Math.max(
          ...(await Promise.all([
            redis.pttl(keys.account.lock),
            redis.pttl(keys.prefix.lock),
          ])),
        ),
      -2,
    );
    return ttlMs > 0 ? Math.ceil(ttlMs / 1000) : null;
  }

  async function recordFailure(email: string, prefix: string): Promise<void> {
    const keys = keysFor(email, prefix);
    const window = [String(FAILURE_WINDOW_MS)];
    await withRedis(async (redis) => {
      const [account, scoped] = await Promise.all([
        redis.eval(CONSUME_SCRIPT, [keys.account.count], window),
        redis.eval(CONSUME_SCRIPT, [keys.prefix.count], window),
      ]);
      const locks: Array<[string, number]> = [
        [keys.account.lock, waitSecondsFor(ACCOUNT_TIERS, Number(account))],
        [keys.prefix.lock, waitSecondsFor(PREFIX_TIERS, Number(scoped))],
      ];
      await Promise.all(
        locks
          .filter(([, wait]) => wait > 0)
          .map(([key, wait]) => redis.set(key, "1", { px: wait * 1000 })),
      );
    }, undefined);
  }

  /** A successful sign-in or a completed password reset clears the address and its caller's prefix. */
  async function clear(email: string, prefix: string): Promise<void> {
    const keys = keysFor(email, prefix);
    await withRedis(
      (redis) =>
        redis.del(
          keys.account.count,
          keys.account.lock,
          keys.prefix.count,
          keys.prefix.lock,
        ),
      0,
    );
  }

  const plugin = {
    id: "account-sign-in-throttle",
    hooks: {
      // The parsed body, so JSON and form-encoded sign-ins are gated alike,
      // before the password is hashed or compared.
      before: [
        {
          matcher: (ctx) => ctx.path === SIGN_IN_PATH,
          handler: createAuthMiddleware(async (ctx) => {
            const body = SignInBodySchema.safeParse(ctx.body);
            if (!body.success) return;
            const wait = await retryAfterSeconds(
              body.data.email,
              networkPrefix(ctx.headers),
            );
            if (wait !== null) return tooManyRequests(wait);
          }),
        },
      ],
      after: [
        {
          matcher: (ctx) => ctx.path === SIGN_IN_PATH,
          handler: createAuthMiddleware(async (ctx) => {
            const body = SignInBodySchema.safeParse(ctx.body);
            if (!body.success) return;
            const prefix = networkPrefix(ctx.headers);
            const returned = ctx.context.returned;
            if (isAPIError(returned)) {
              if (returned.body?.code === "INVALID_EMAIL_OR_PASSWORD") {
                await recordFailure(body.data.email, prefix);
              }
              return;
            }
            if (returned instanceof Error) return;
            // A session, or a pending 2FA challenge: the password matched.
            await clear(body.data.email, prefix);
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
