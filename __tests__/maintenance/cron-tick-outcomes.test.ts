/** @jest-environment node */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { dueTargets } from "../../lib/cron/schedule";

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
      NODE_ENV: "test",
      CRON_SECRET: "test",
      CRON_TICK_BASE_URL: "https://app.test",
      NEXT_PUBLIC_SENTRY_DSN: "https://key@sentry.test/1",
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

  it("separates background admission from completed targets and never admits an ordinary 202", async () => {
    const fetchImpl = jest.fn(
      async (input: string | URL | Request) =>
        new Response("{}", {
          status: String(input).includes("recording-transfer-background")
            ? 202
            : 200,
        }),
    );
    const ticker = load(fetchImpl);
    const response = await ticker.default(new Request("https://tick.test"));
    const body = await response.json();
    expect(body.accepted).toEqual(["transfer-recordings"]);
    expect(body.ok).not.toContain("transfer-recordings");
    expect(body.failed).toEqual([]);
    expect(ticker.bucketFor(202, false, "release-earnings")).toBe("failed");
  });

  it("reports rejected check-ins without re-firing completed targets", async () => {
    const error = jest.spyOn(console, "error").mockImplementation(() => {});
    const fetchImpl = jest.fn(async (input: string | URL | Request) => {
      const url = String(input);
      return url.includes("sentry.test")
        ? new Response("rejected", { status: 403 })
        : new Response("{}", {
            status: url.includes("recording-transfer-background") ? 202 : 200,
            headers: { "X-Job-Outcome": "success" },
          });
    });
    const ticker = load(fetchImpl);
    const response = await ticker.default(new Request("https://tick.test"));
    expect(response.status).toBe(200);
    const expectedTargets = dueTargets(new Date());
    // Targets, the slot claim, the background outcome read and the check-in.
    expect(fetchImpl).toHaveBeenCalledTimes(expectedTargets.length + 3);
    expect(error).toHaveBeenCalledWith(
      JSON.stringify({ event: "cron-checkin-rejected", status: 403 }),
    );
  });

  it("stands down on any deploy context other than production", async () => {
    const fetchImpl = jest.fn(async () => new Response("{}"));
    jest.spyOn(console, "log").mockImplementation(() => {});
    const res = await load(fetchImpl).default(
      new Request("https://tick.test"),
      { deploy: { context: "branch-deploy", id: "d1" } },
    );
    expect(await res.json()).toEqual({
      skipped: true,
      deployContext: "branch-deploy",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("stands down on an already-claimed slot and retries a connection failure once", async () => {
    const duplicate = jest.fn(async (input: string | URL | Request) =>
      String(input).includes("/api/health/jobs/tick")
        ? new Response(JSON.stringify({ claimed: false }))
        : new Response("{}"),
    );
    const skipped = await load(duplicate).default(
      new Request("https://tick.test"),
    );
    expect(await skipped.json()).toMatchObject({ duplicate: true });
    expect(duplicate).toHaveBeenCalledTimes(1);

    const target = dueTargets(new Date()).find(
      (name) => name !== "transfer-recordings",
    );
    let dropped = false;
    const flaky = jest.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes(`/api/cleanup/${target}`) && !dropped) {
        dropped = true;
        throw new TypeError("fetch failed");
      }
      return new Response("{}", {
        status: url.includes("-background") ? 202 : 200,
      });
    });
    jest.spyOn(console, "log").mockImplementation(() => {});
    const body = await (
      await load(flaky).default(new Request("https://tick.test"))
    ).json();
    expect(body.ok).toContain(target);
    expect(body.failed).toEqual([]);
  });

  describe("Better Stack summary line", () => {
    beforeEach(() => {
      process.env = {
        ...process.env,
        ENABLE_BETTERSTACK_TELEMETRY: "true",
        BETTERSTACK_SOURCE_TOKEN: "tok",
        BETTERSTACK_INGEST_URL: "https://ingest.betterstack.test",
      };
    });

    it("logs the status of a rejected summary without the token", async () => {
      const error = jest.spyOn(console, "error").mockImplementation(() => {});
      const fetchImpl = jest.fn(async (input: string | URL | Request) =>
        String(input).includes("betterstack.test")
          ? new Response("bad token", { status: 401 })
          : new Response("{}", {
              status: String(input).includes("recording-transfer-background")
                ? 202
                : 200,
            }),
      );
      await load(fetchImpl).default(new Request("https://tick.test"));
      expect(error).toHaveBeenCalledWith(
        JSON.stringify({ event: "betterstack-summary-rejected", status: 401 }),
      );
      expect(JSON.stringify(error.mock.calls)).not.toContain("tok");
    });

    it("emits an error summary when CRON_SECRET is missing", async () => {
      jest.spyOn(console, "error").mockImplementation(() => {});
      jest.useRealTimers();
      delete process.env.CRON_SECRET;
      delete process.env.NEXT_PUBLIC_SENTRY_DSN;
      const fetchImpl = jest.fn(
        async (_input: string | URL | Request, _init?: RequestInit) =>
          new Response("{}", { status: 202 }),
      );
      await load(fetchImpl).default(new Request("https://tick.test"));
      const summary = fetchImpl.mock.calls.find(([input]) =>
        String(input).includes("betterstack.test"),
      );
      expect(summary).toBeDefined();
      const payload = JSON.parse(String(summary?.[1]?.body));
      expect(payload.level).toBe("error");
      expect(payload.error).toMatch(/CRON_SECRET is not set/);
    });
  });
});
