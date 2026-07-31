/**
 * #1066 — the half of the cron-Sentry fix that is most likely to regress.
 *
 * `Sentry.init` in a job process is worthless on its own: the SDK batches over
 * HTTP and the process exits as soon as the work is done. So these tests are
 * mostly about `flush` being unconditional — after a normal completion, after
 * an early `return`, and after a throw — rather than about capture, which is
 * the easy half to get right.
 */

const initSentry = jest.fn();
jest.mock("../../sentry.shared.config", () => ({
  __esModule: true,
  initSentry: () => initSentry(),
}));

const flush = jest.fn(async (_timeoutMs?: number) => true);
const captureException = jest.fn();
jest.mock("@sentry/nextjs", () => ({
  __esModule: true,
  flush: (timeoutMs?: number) => flush(timeoutMs),
  captureException: (...args: unknown[]) => captureException(...args),
}));

type JobSentryModule = typeof import("../../lib/observability/job-sentry");

/** Fresh module registry each time so the one-shot `init` guard resets. */
function loadModule(): JobSentryModule {
  let mod!: JobSentryModule;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    mod = require("../../lib/observability/job-sentry") as JobSentryModule;
  });
  return mod;
}

describe("job Sentry runner", () => {
  let originalExitCode: typeof process.exitCode;
  let consoleError: jest.SpyInstance;
  let consoleWarn: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    flush.mockImplementation(async () => true);
    originalExitCode = process.exitCode;
    process.exitCode = undefined;
    // The runner logs every failure it captures; these suites throw on purpose.
    consoleError = jest.spyOn(console, "error").mockImplementation(() => {});
    consoleWarn = jest.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    process.exitCode = originalExitCode;
    consoleError.mockRestore();
    consoleWarn.mockRestore();
  });

  describe("flushes on every exit path", () => {
    it("flushes after the body completes normally", async () => {
      const { runJobWithSentry } = loadModule();

      await runJobWithSentry("happy-job", async () => {});

      expect(flush).toHaveBeenCalledTimes(1);
      expect(process.exitCode).toBeUndefined();
    });

    it("flushes when the body returns early without doing its work", async () => {
      // The lock-held / maintenance-skip shape: the body bails, but it may
      // already have queued a log or a breadcrumb.
      const { runJobWithSentry } = loadModule();
      const lockHeld = jest.fn(() => true);
      const afterReturn = jest.fn();

      await runJobWithSentry("early-return-job", async () => {
        if (lockHeld()) return;
        afterReturn();
      });

      expect(afterReturn).not.toHaveBeenCalled();
      expect(flush).toHaveBeenCalledTimes(1);
      expect(captureException).not.toHaveBeenCalled();
      // An early return is a clean skip, not a failure.
      expect(process.exitCode).toBeUndefined();
    });

    it("flushes AFTER capturing when the body throws", async () => {
      const { runJobWithSentry } = loadModule();
      const boom = new Error("job blew up");
      const order: string[] = [];
      captureException.mockImplementation(() => order.push("capture"));
      flush.mockImplementation(async () => {
        order.push("flush");
        return true;
      });

      await runJobWithSentry("throwing-job", async () => {
        throw boom;
      });

      // Flushing before the capture would drain an empty queue and drop the
      // very event the run exists to report.
      expect(order).toEqual(["capture", "flush"]);
      expect(captureException).toHaveBeenCalledTimes(1);
      expect(process.exitCode).toBe(1);
    });

    it("does not rethrow a body error (an unhandled rejection would kill the flush)", async () => {
      const { runJobWithSentry } = loadModule();

      await expect(
        runJobWithSentry("throwing-job", async () => {
          throw new Error("job blew up");
        }),
      ).resolves.toBeUndefined();
    });

    it("tags the captured error with the job name", async () => {
      const { runJobWithSentry } = loadModule();

      await runJobWithSentry("tagged-job", async () => {
        throw new Error("nope");
      });

      const [, context] = captureException.mock.calls[0] as [
        unknown,
        { tags: Record<string, string> },
      ];
      expect(context.tags).toMatchObject({
        subsystem: "jobs",
        job: "tagged-job",
      });
    });

    it("normalises a non-Error throw instead of dropping it", async () => {
      const { runJobWithSentry } = loadModule();

      await runJobWithSentry("string-throw-job", async () => {
        throw "just a string";
      });

      const [captured] = captureException.mock.calls[0] as [Error];
      expect(captured).toBeInstanceOf(Error);
      expect(captured.message).toBe("just a string");
    });
  });

  describe("exit code", () => {
    it("preserves an exit code the body set for itself", async () => {
      // Jobs signal "ran, but found problems" this way now that they can no
      // longer call process.exit().
      const { runJobWithSentry } = loadModule();

      await runJobWithSentry("discrepancy-job", async () => {
        process.exitCode = 2;
      });

      expect(process.exitCode).toBe(2);
      expect(flush).toHaveBeenCalledTimes(1);
    });
  });

  describe("init", () => {
    it("initialises before the body runs, reusing the app's shared config", async () => {
      const { runJobWithSentry } = loadModule();
      const order: string[] = [];
      initSentry.mockImplementation(() => order.push("init"));

      await runJobWithSentry("ordered-job", async () => {
        order.push("body");
      });

      expect(order).toEqual(["init", "body"]);
    });

    it("initialises once even across several runs in the same process", async () => {
      const { runJobWithSentry } = loadModule();

      await runJobWithSentry("a", async () => {});
      await runJobWithSentry("b", async () => {});

      expect(initSentry).toHaveBeenCalledTimes(1);
      expect(flush).toHaveBeenCalledTimes(2);
    });
  });

  describe("flush failure", () => {
    it("does not fail the job when the transport cannot be drained", async () => {
      const { runJobWithSentry } = loadModule();
      flush.mockImplementation(async () => {
        throw new Error("network down");
      });

      await expect(
        runJobWithSentry("undrainable-job", async () => {}),
      ).resolves.toBeUndefined();
      expect(process.exitCode).toBeUndefined();
    });

    it("still reports the body's failure when the flush itself fails", async () => {
      const { runJobWithSentry } = loadModule();
      flush.mockImplementation(async () => {
        throw new Error("network down");
      });

      await runJobWithSentry("undrainable-failing-job", async () => {
        throw new Error("boom");
      });

      expect(captureException).toHaveBeenCalledTimes(1);
      expect(process.exitCode).toBe(1);
    });
  });

  describe("runJob (module-tail form)", () => {
    it("runs the body and flushes without the caller awaiting anything", async () => {
      const { runJob } = loadModule();
      const body = jest.fn(async () => {});

      runJob("tail-job", body);
      // Fire-and-forget: let the microtask queue drain.
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(body).toHaveBeenCalledTimes(1);
      expect(flush).toHaveBeenCalledTimes(1);
    });

    it("swallows a throwing body rather than raising an unhandled rejection", async () => {
      const { runJob } = loadModule();

      runJob("tail-throwing-job", async () => {
        throw new Error("boom");
      });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(process.exitCode).toBe(1);
      expect(flush).toHaveBeenCalled();
    });
  });
});
