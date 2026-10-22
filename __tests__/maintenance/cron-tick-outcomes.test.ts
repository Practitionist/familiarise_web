/** @jest-environment node */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

type Ticker = typeof import("../../netlify/functions/cron-tick.mjs");

function load(fetchImpl: typeof fetch): Ticker {
  const source = fs.readFileSync(
    path.join(__dirname, "../../netlify/functions/cron-tick.mts"),
    "utf8",
  );
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  });
  const mod = { exports: {} };
  vm.runInNewContext(outputText, {
    module: mod,
    exports: mod.exports,
    require,
    process,
    setTimeout,
    clearTimeout,
    AbortController,
    Response,
    URL,
    Date,
    console,
    fetch: fetchImpl,
  });
  return Object.assign(Object.create(null), mod.exports);
}

describe("ticker execution outcomes", () => {
  const originalEnv = process.env;
  beforeEach(() => {
    process.env = {
      CRON_SECRET: "test",
      CRON_TICK_BASE_URL: "https://app.test",
      SENTRY_DSN: "https://key@sentry.test/1",
    };
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-10-22T06:00:00Z"));
  });
  afterEach(() => {
    process.env = originalEnv;
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("does not classify a partial failure as healthy even on an ordinary target", () => {
    const ticker = load(jest.fn());
    expect(
      ticker.bucketFor(207, false, "release-earnings", "partial_failure"),
    ).toBe("failed");
    expect(ticker.bucketFor(503, false, "release-earnings", "held")).toBe(
      "held",
    );
  });

  it("preserves partial payout failure even with a success header", () => {
    expect(
      load(jest.fn()).bucketFor(207, false, "process-payouts", "success"),
    ).toBe("failed");
  });

  it("reports rejected check-ins without re-firing completed targets", async () => {
    const error = jest.spyOn(console, "error").mockImplementation(() => {});
    const fetchImpl = jest.fn(async (input: string | URL | Request) => {
      const url = String(input);
      return url.includes("sentry.test")
        ? new Response("rejected", { status: 403 })
        : new Response("{}", {
            status: 200,
            headers: { "X-Job-Outcome": "success" },
          });
    });
    const ticker = load(fetchImpl);
    const response = await ticker.default(new Request("https://tick.test"));
    expect(response.status).toBe(200);
    const expectedTargets = ticker.dueTargets(new Date());
    expect(fetchImpl).toHaveBeenCalledTimes(expectedTargets.length + 1);
    expect(error).toHaveBeenCalledWith(
      JSON.stringify({ event: "cron-checkin-rejected", status: 403 }),
    );
  });
});
