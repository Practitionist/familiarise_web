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
