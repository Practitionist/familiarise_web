/**
 * @jest-environment node
 */

/**
 * Better Stack Telemetry sink: no network when the flag is off, a Bearer-authed
 * POST of fixed fields when configured, and a typed outcome instead of a throw.
 */

describe("emitTelemetryLog", () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...OLD_ENV };
  });

  afterEach(() => {
    process.env = OLD_ENV;
    jest.restoreAllMocks();
  });

  it("is a no-op (no fetch) when the flag is off", async () => {
    process.env.ENABLE_BETTERSTACK_TELEMETRY = "false";
    process.env.BETTERSTACK_SOURCE_TOKEN = "tok";
    process.env.BETTERSTACK_INGEST_URL = "https://in.example.com";
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy as never;

    const { emitTelemetryLog } =
      await import("@/lib/observability/betterstack-telemetry");
    await emitTelemetryLog({ level: "error", message: "boom" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does NOT fetch when flag on but token/url missing", async () => {
    process.env.ENABLE_BETTERSTACK_TELEMETRY = "true";
    delete process.env.BETTERSTACK_SOURCE_TOKEN;
    delete process.env.BETTERSTACK_INGEST_URL;
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy as never;

    const { emitTelemetryLog } =
      await import("@/lib/observability/betterstack-telemetry");
    await emitTelemetryLog({ level: "warn", message: "x" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("POSTs only the fixed fields with a Bearer source token when on+configured", async () => {
    process.env.ENABLE_BETTERSTACK_TELEMETRY = "true";
    process.env.BETTERSTACK_SOURCE_TOKEN = "tok-123";
    process.env.BETTERSTACK_INGEST_URL = "https://in.example.com";
    const fetchSpy = jest.fn().mockResolvedValue({ status: 202 });
    global.fetch = fetchSpy as never;

    const { emitTelemetryLog } =
      await import("@/lib/observability/betterstack-telemetry");
    await expect(
      emitTelemetryLog({
        level: "error",
        message: "stuck payout for priya@example.com",
        category: "PAYOUT",
        entity_id: "pay_123",
      }),
    ).resolves.toBe("sent");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://in.example.com");
    expect(opts.method).toBe("POST");
    expect(opts.headers.Authorization).toBe("Bearer tok-123");
    const body = JSON.parse(opts.body);
    expect(Object.keys(body).sort()).toEqual(
      ["category", "dt", "entity_id", "level", "message"].sort(),
    );
    expect(body.message).not.toContain("priya@example.com");
  });

  it("buckets rejections and network failures without throwing", async () => {
    process.env.ENABLE_BETTERSTACK_TELEMETRY = "true";
    process.env.BETTERSTACK_SOURCE_TOKEN = "tok";
    process.env.BETTERSTACK_INGEST_URL = "https://in.example.com";
    jest.spyOn(console, "warn").mockImplementation(() => {});
    const { emitTelemetryLog } =
      await import("@/lib/observability/betterstack-telemetry");
    const outcomes: string[] = [];
    for (const status of [402, 403, 503, 429]) {
      global.fetch = jest.fn().mockResolvedValue({ status }) as never;
      outcomes.push(await emitTelemetryLog({ level: "warn", message: "x" }));
    }
    global.fetch = jest
      .fn()
      .mockRejectedValue(new Error("network down")) as never;
    outcomes.push(await emitTelemetryLog({ level: "error", message: "x" }));

    expect(outcomes).toEqual(["402", "403", "5xx", "other", "network"]);
  });
});
