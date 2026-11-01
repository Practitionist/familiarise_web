/** @jest-environment node */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { dueTargets, isFirstDueTickOfHour } from "../../lib/cron/schedule";

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

  it("skips only the due targets the claim names idle, and dispatches all when the probe is unreadable", async () => {
    const due = dueTargets(new Date());
    const idleName = due.find((name) => name !== "transfer-recordings");
    const dispatched: string[] = [];
    const ticker = (claim: () => Response) =>
      load(
        jest.fn(async (input: string | URL | Request) => {
          const url = new URL(String(input));
          if (url.pathname === "/api/health/jobs/tick") return claim();
          if (
            url.pathname.startsWith("/api/cleanup/") ||
            url.pathname.startsWith("/.netlify/functions/")
          ) {
            dispatched.push(url.pathname.split("/").pop() ?? "");
          }
          return new Response("{}", {
            status: url.pathname.includes("-background") ? 202 : 200,
          });
        }),
      );
    jest.spyOn(console, "log").mockImplementation(() => {});
    const skipping = await (
      await ticker(
        () =>
          new Response(
            JSON.stringify({ claimed: true, idle: [idleName, "not-due"] }),
          ),
      ).default(new Request("https://tick.test"))
    ).json();
    expect(skipping.skippedIdle).toEqual([idleName]);
    expect(dispatched).not.toContain(idleName);
    expect(dispatched).toHaveLength(due.length - 1);

    dispatched.length = 0;
    const failOpen = await (
      await ticker(() => {
        throw new TypeError("fetch failed");
      }).default(new Request("https://tick.test"))
    ).json();
    expect(failOpen.skippedIdle).toEqual([]);
    expect(dispatched).toHaveLength(due.length);
  });

  it("keeps the first failure when the retry meets the crashed call's lease", async () => {
    // A repeat tick of the hour, so the failure skips the Sentry alert path.
    jest.setSystemTime(new Date("2026-10-22T06:30:00Z"));
    const now = new Date();
    const target = dueTargets(now).find(
      (name) =>
        name !== "transfer-recordings" && !isFirstDueTickOfHour(name, now),
    );
    expect(target).toBeDefined();
    let calls = 0;
    const crashed = jest.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes(`/api/cleanup/${target}`)) {
        calls += 1;
        if (calls === 1) throw new TypeError("fetch failed");
        return new Response("{}", { status: 409 });
      }
      return new Response("{}", {
        status: url.includes("-background") ? 202 : 200,
      });
    });
    jest.spyOn(console, "log").mockImplementation(() => {});
    jest.spyOn(console, "warn").mockImplementation(() => {});
    jest.spyOn(console, "error").mockImplementation(() => {});
    const body = await (
      await load(crashed).default(new Request("https://tick.test"))
    ).json();
    expect(calls).toBe(2);
    expect(body.failed).toEqual([{ name: target, status: 0 }]);
    expect(body.lockHeld).toEqual([]);
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
