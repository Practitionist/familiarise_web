/**
 * @jest-environment node
 *
 * BetterAuth rate limiting on Upstash (lib/auth/rate-limit.ts).
 *
 * The store runs against the in-repo MockRedis, whose Lua subset is what the
 * consume script is written to, so the same script is exercised here as runs
 * against Upstash.
 */

import fs from "fs";
import path from "path";
import { MockRedis } from "../../lib/redis-mock";
import { captureThrottled } from "../../lib/observability/throttled-capture";
import {
  AUTH_RATE_LIMIT_RULES,
  authRateLimit,
  createUpstashRateLimitStorage,
  withRetryAfter,
  type RateLimitRedis,
} from "../../lib/auth/rate-limit";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import {
  ACCOUNT_TIERS,
  PREFIX_TIERS,
  createSignInThrottle,
  networkPrefix,
  waitSecondsFor,
} from "../../lib/auth/account-throttle";

jest.mock("../../lib/observability/throttled-capture", () => ({
  captureThrottled: jest.fn(),
}));

const rule = { window: 60, max: 3 };

function storeOn(redis: RateLimitRedis) {
  return createUpstashRateLimitStorage(async () => redis);
}

describe("Upstash rate-limit store", () => {
  it("allows up to max, then refuses with the window's remaining seconds", async () => {
    const store = storeOn(new MockRedis());
    const key = "203.0.113.7|/sign-in/email";

    for (let i = 0; i < rule.max; i++) {
      await expect(store.consume(key, rule)).resolves.toEqual({
        allowed: true,
        retryAfter: null,
      });
    }
    const refused = await store.consume(key, rule);
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfter).toBeGreaterThan(0);
    expect(refused.retryAfter).toBeLessThanOrEqual(rule.window);
  });

  it("counts each IP and path separately", async () => {
    const store = storeOn(new MockRedis());
    const one = { window: 60, max: 1 };
    await store.consume("203.0.113.7|/sign-in/email", one);
    await expect(
      store.consume("203.0.113.8|/sign-in/email", one),
    ).resolves.toMatchObject({ allowed: true });
    await expect(
      store.consume("203.0.113.7|/sign-up/email", one),
    ).resolves.toMatchObject({ allowed: true });
  });

  it("sets the TTL on the first hit, so a counter cannot outlive its window", async () => {
    const redis = new MockRedis();
    await storeOn(redis).consume("203.0.113.7|/sign-in/email", rule);
    const [stored] = redis.keys();
    const ttl = await redis.pttl(stored);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(rule.window * 1000);
  });

  it("never writes the path (which can carry a reset token) into a key", async () => {
    const redis = new MockRedis();
    await storeOn(redis).consume(
      "203.0.113.7|/reset-password/secret-token",
      rule,
    );
    const keys = redis.keys();
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^rl:ba:[0-9a-f]{64}$/);
  });

  it("fails open and reports when Redis errors", async () => {
    const broken: RateLimitRedis = {
      eval: jest.fn().mockRejectedValue(new Error("upstash down")),
      pttl: jest.fn(),
    };
    await expect(
      storeOn(broken).consume("203.0.113.7|/sign-in/email", rule),
    ).resolves.toEqual({ allowed: true, retryAfter: null });
    expect(captureThrottled).toHaveBeenCalledWith(
      "auth:rate-limit-store",
      expect.any(Error),
      expect.objectContaining({ subsystem: "auth", expected: false }),
    );
  });

  it("fails open when Redis hangs", async () => {
    const hung: RateLimitRedis = {
      eval: () => new Promise(() => {}),
      pttl: jest.fn(),
    };
    await expect(
      storeOn(hung).consume("203.0.113.7|/sign-in/email", rule),
    ).resolves.toEqual({ allowed: true, retryAfter: null });
  });

  it("skips loopback outside production without touching Redis", async () => {
    const redis: RateLimitRedis = { eval: jest.fn(), pttl: jest.fn() };
    await expect(
      storeOn(redis).consume("127.0.0.1|/sign-in/email", rule),
    ).resolves.toEqual({ allowed: true, retryAfter: null });
    expect(redis.eval).not.toHaveBeenCalled();
  });
});

describe("auth rate-limit config", () => {
  it("is enabled in every environment, with the Upstash store", () => {
    expect(authRateLimit.enabled).toBe(true);
    expect(authRateLimit.customStorage).toBeDefined();
  });

  it.each([
    "/sign-in/email",
    "/sign-up/email",
    "/request-password-reset",
    "/reset-password",
    "/reset-password/*",
    "/email-otp/send-verification-otp",
    "/email-otp/verify-email",
    "/change-password",
    "/two-factor/verify-*",
    "/two-factor/*",
    "/sign-in/social",
    "/callback/*",
    "/sign-in/sso",
    "/sso/callback/*",
  ])("budgets %s", (p) => {
    expect(AUTH_RATE_LIMIT_RULES[p]).toEqual(
      expect.objectContaining({ window: expect.any(Number) }),
    );
  });

  it("holds the mail-sending paths to a few calls an hour per IP", () => {
    for (const p of [
      "/sign-up/email",
      "/request-password-reset",
      "/email-otp/send-verification-otp",
    ]) {
      const rule = AUTH_RATE_LIMIT_RULES[p];
      if (!rule || typeof rule === "function") throw new Error(`no rule: ${p}`);
      expect(rule.max / (rule.window / 3600)).toBeLessThanOrEqual(5);
    }
  });

  it("lists the 2FA verify rule before the broader /two-factor/* rule", () => {
    // BetterAuth takes the first matching key.
    const keys = Object.keys(AUTH_RATE_LIMIT_RULES);
    expect(keys.indexOf("/two-factor/verify-*")).toBeLessThan(
      keys.indexOf("/two-factor/*"),
    );
  });

  it("is what lib/auth.ts passes to BetterAuth", () => {
    const authSrc = fs.readFileSync(
      path.join(__dirname, "..", "..", "lib", "auth.ts"),
      "utf8",
    );
    expect(authSrc).toMatch(/rateLimit:\s*authRateLimit,/);
  });
});

describe("withRetryAfter", () => {
  it("mirrors X-Retry-After into Retry-After on a 429", () => {
    const res = withRetryAfter(
      new Response("{}", { status: 429, headers: { "X-Retry-After": "42" } }),
    );
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("42");
    expect(res.headers.get("X-Retry-After")).toBe("42");
  });

  it("leaves other responses alone", () => {
    const ok = new Response("{}", { status: 200 });
    expect(withRetryAfter(ok)).toBe(ok);
  });
});

describe("per-account sign-in throttle on a real instance", () => {
  const APP = "http://localhost:3000";
  const redis = new MockRedis();
  const throttle = createSignInThrottle(async () => redis);
  const auth = betterAuth({
    secret: "test-secret-that-is-at-least-32-characters",
    baseURL: APP,
    database: memoryAdapter({
      user: [],
      session: [],
      account: [],
      verification: [],
    }),
    emailAndPassword: { enabled: true },
    rateLimit: { enabled: false },
    plugins: [throttle.plugin],
  });

  // Form-encoded, the body type a JSON-only gate would miss.
  const signIn = (password: string, ip: string) =>
    auth.handler(
      new Request(`${APP}/api/auth/sign-in/email`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: APP,
          "x-forwarded-for": ip,
        },
        body: new URLSearchParams({ email: "victim@b.test", password }),
      }),
    );

  beforeAll(async () => {
    await auth.api.signUpEmail({
      body: { email: "victim@b.test", password: "correct-horse-1", name: "V" },
    });
  });

  it("escalates per address to 2 minutes at most, and to 15 minutes only per network prefix", () => {
    expect(waitSecondsFor(ACCOUNT_TIERS, 9)).toBe(0);
    expect(waitSecondsFor(ACCOUNT_TIERS, 10)).toBe(30);
    expect(waitSecondsFor(ACCOUNT_TIERS, 400)).toBe(120);
    expect(waitSecondsFor(PREFIX_TIERS, 39)).toBe(0);
    expect(waitSecondsFor(PREFIX_TIERS, 40)).toBe(900);
  });

  it("blocks a form-encoded guess with BetterAuth's 429 and never lets a stranger hold a long lock", async () => {
    for (let i = 0; i < 9; i++) {
      expect((await signIn("wrong", "203.0.113.7")).status).toBe(401);
    }
    expect((await signIn("wrong", "203.0.113.8")).status).toBe(401);
    const refused = await signIn("correct-horse-1", "203.0.113.9");
    expect(refused.status).toBe(429);
    expect(refused.headers.get("X-Retry-After")).toBe("30");

    // 40 failures from one /24 lock that prefix for 15 minutes; the victim on
    // another network waits only the per-address 2 minutes.
    for (let i = 0; i < 40; i++) {
      await throttle.recordFailure("victim@b.test", "203.0.113.0/24");
    }
    const attacker = await signIn("wrong", "203.0.113.50");
    expect(Number(attacker.headers.get("X-Retry-After"))).toBeGreaterThan(120);
    const victim = await signIn("correct-horse-1", "198.51.100.4");
    expect(Number(victim.headers.get("X-Retry-After"))).toBeLessThanOrEqual(
      120,
    );
  });

  it("names the /24 or /48 the caller signs in from", () => {
    expect(
      networkPrefix(new Headers({ "x-forwarded-for": "203.0.113.77" })),
    ).toBe("203.0.113.0/24");
    expect(
      networkPrefix(new Headers({ "x-forwarded-for": "2001:db8:abcd:12::1" })),
    ).toBe("2001:0db8:abcd:0000:0000:0000:0000:0000");
  });

  it("fails open when Redis is down", async () => {
    const down = createSignInThrottle(async () => {
      throw new Error("upstash down");
    });
    await expect(
      down.recordFailure("a@b.test", "unknown_ip"),
    ).resolves.toBeUndefined();
  });
});
