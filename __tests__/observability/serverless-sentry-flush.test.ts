/**
 * Server exceptions reach Sentry from a Netlify function: every capture through
 * `reportSentryError` / `reportSentryMessage` schedules a bounded flush, which
 * rides `after()` inside a request and is awaited outside one, so the instance
 * cannot freeze with the event still queued. Off Netlify nothing is added.
 */

const captureException = jest.fn(() => "evt");
const captureMessage = jest.fn(() => "evt");
jest.mock("@sentry/core", () => ({
  captureException: (...args: unknown[]) => captureException(...args),
  captureMessage: (...args: unknown[]) => captureMessage(...args),
}));
const flush = jest.fn(async (_timeoutMs?: number) => true);
jest.mock("@sentry/nextjs", () => ({
  flush: (timeoutMs?: number) => flush(timeoutMs),
}));
const after = jest.fn();
jest.mock("next/server", () => ({
  after: (task: () => Promise<void>) => after(task),
}));
jest.mock("../../sentry.shared.config", () => ({ initSentry: jest.fn() }));

import {
  reportSentryError,
  setAfterCapture,
} from "../../lib/observability/report";
import { scheduleSentryFlush } from "../../lib/observability/serverless-flush";

const ORIGINAL_NETLIFY = process.env.NETLIFY;

beforeEach(() => {
  jest.clearAllMocks();
  setAfterCapture(null);
});

afterAll(() => {
  if (ORIGINAL_NETLIFY === undefined) delete process.env.NETLIFY;
  else process.env.NETLIFY = ORIGINAL_NETLIFY;
});

/** Boots the server Sentry config in a fresh registry and returns that registry's reporters. */
async function loadServerRuntime(netlify: string | undefined) {
  if (netlify === undefined) delete process.env.NETLIFY;
  else process.env.NETLIFY = netlify;
  let report: typeof import("../../lib/observability/report") | undefined;
  await jest.isolateModulesAsync(async () => {
    await import("../../sentry.server.config");
    report = await import("../../lib/observability/report");
  });
  if (!report) throw new Error("report module did not load");
  return report;
}

describe("scheduleSentryFlush", () => {
  it("hands a 2 s flush to after() inside a request, which awaits it", async () => {
    let release: (drained: boolean) => void = () => undefined;
    flush.mockImplementationOnce(
      () => new Promise<boolean>((resolve) => (release = resolve)),
    );

    await scheduleSentryFlush();

    expect(after).toHaveBeenCalledTimes(1);
    const task = after.mock.calls[0][0] as () => Promise<void>;
    let settled = false;
    const running = task().then(() => (settled = true));
    await Promise.resolve();
    expect(flush).toHaveBeenCalledWith(2_000);
    expect(settled).toBe(false);
    release(true);
    await running;
    expect(settled).toBe(true);
  });

  it("returns the flush for the caller to await outside a request", async () => {
    after.mockImplementationOnce(() => {
      throw new Error("after() called outside a request scope");
    });
    let release: (drained: boolean) => void = () => undefined;
    flush.mockImplementationOnce(
      () => new Promise<boolean>((resolve) => (release = resolve)),
    );

    let settled = false;
    const pending = scheduleSentryFlush().then(() => (settled = true));
    await Promise.resolve();
    expect(flush).toHaveBeenCalledWith(2_000);
    expect(settled).toBe(false);
    release(true);
    await pending;
    expect(settled).toBe(true);
  });

  it("never rejects when the flush times out or throws", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    after.mockImplementation(() => {
      throw new Error("no request scope");
    });
    flush.mockResolvedValueOnce(false);
    await expect(scheduleSentryFlush()).resolves.toBeUndefined();
    flush.mockRejectedValueOnce(new Error("transport down"));
    await expect(scheduleSentryFlush()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(2);
    after.mockReset();
    warn.mockRestore();
  });
});

describe("the server runtime on Netlify flushes after every capture", () => {
  it("schedules a flush after reportSentryError and reportSentryMessage", async () => {
    const report = await loadServerRuntime("true");
    jest.spyOn(console, "error").mockImplementation(() => {});

    report.reportSentryError(new Error("ledger posting failed"), {
      subsystem: "payments",
    });
    report.reportSentryMessage("checkout refused", {
      subsystem: "payments",
      level: "warning",
    });

    expect(captureException).toHaveBeenCalledTimes(1);
    expect(captureMessage).toHaveBeenCalledTimes(1);
    expect(after).toHaveBeenCalledTimes(2);
  });

  it("adds no flush off Netlify", async () => {
    const report = await loadServerRuntime(undefined);
    jest.spyOn(console, "error").mockImplementation(() => {});

    report.reportSentryError(new Error("boom"), { subsystem: "payments" });

    expect(captureException).toHaveBeenCalledTimes(1);
    expect(after).not.toHaveBeenCalled();
    expect(flush).not.toHaveBeenCalled();
  });

  it("a failing hook never breaks the capture", () => {
    setAfterCapture(() => {
      throw new Error("hook broke");
    });
    jest.spyOn(console, "error").mockImplementation(() => {});

    expect(
      reportSentryError(new Error("boom"), { subsystem: "payments" }),
    ).toBe("evt");
  });
});
