/**
 * @jest-environment node
 */

describe("redis-edge Jest moduleNameMapper network guard", () => {
  const originalUrl = process.env.UPSTASH_REDIS_REST_URL;
  const originalToken = process.env.UPSTASH_REDIS_REST_TOKEN;

  beforeAll(() => {
    process.env.UPSTASH_REDIS_REST_URL = "https://invalid.upstash.invalid";
    process.env.UPSTASH_REDIS_REST_TOKEN = "invalid-test-token";
  });

  afterAll(() => {
    process.env.UPSTASH_REDIS_REST_URL = originalUrl;
    process.env.UPSTASH_REDIS_REST_TOKEN = originalToken;
  });

  it("enforces sliding-window rate limits in memory with zero HTTP requests even when Upstash env vars point to an invalid host", async () => {
    const fetchSpy = jest.spyOn(globalThis, "fetch").mockImplementation(() => {
      throw new Error("Unexpected network fetch to Upstash REST API");
    });

    const { makeLimiter, applyRateLimit } = await import("@/lib/rate-limit");
    const limiter = makeLimiter(2, "1 m", "rl:test-guard");

    const first = await applyRateLimit(limiter, "actor-1");
    const second = await applyRateLimit(limiter, "actor-1");
    const third = await applyRateLimit(limiter, "actor-1");

    expect(first).toBeNull();
    expect(second).toBeNull();
    expect(third).not.toBeNull();
    expect(third?.status).toBe(429);
    expect(fetchSpy).not.toHaveBeenCalled();

    fetchSpy.mockRestore();
  });
});
