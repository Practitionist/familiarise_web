/**
 * `initJobSentry` environment gating and `flushJobSentry` drain behaviour.
 * The SDK is faked; sentry.shared.config runs for real because the gating is
 * the thing under test.
 */

const init = jest.fn();
const flush = jest.fn(async (_timeoutMs?: number) => true);
jest.mock("@sentry/nextjs", () => ({
  __esModule: true,
  init: (options: unknown) => init(options),
}));
jest.mock("@sentry/core", () => ({
  __esModule: true,
  flush: (timeoutMs?: number) => flush(timeoutMs),
}));

type SentryInitOptions = { enabled?: boolean; tracesSampleRate?: number };
const lastInitOptions = (): SentryInitOptions =>
  init.mock.calls.at(-1)?.[0] as SentryInitOptions;

type JobSentryModule = typeof import("../../lib/observability/job-sentry");

/** Fresh module registry each time so the one-shot `init` guard resets. */
function loadModule(): JobSentryModule {
  let mod!: JobSentryModule;
  jest.isolateModules(() => {
    mod = jest.requireActual(
      "../../lib/observability/job-sentry",
    ) as JobSentryModule;
  });
  return mod;
}

describe("job Sentry", () => {
  const ORIGINAL_ENV = process.env;
  let consoleError: jest.SpyInstance;
  let consoleWarn: jest.SpyInstance;
  let consoleLog: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    flush.mockImplementation(async () => true);
    process.env = { ...ORIGINAL_ENV };
    consoleError = jest.spyOn(console, "error").mockImplementation(() => {});
    consoleWarn = jest.spyOn(console, "warn").mockImplementation(() => {});
    consoleLog = jest.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
    consoleError.mockRestore();
    consoleWarn.mockRestore();
    consoleLog.mockRestore();
  });

  describe("initJobSentry", () => {
    it("initialises once even when called repeatedly", () => {
      const { initJobSentry } = loadModule();

      initJobSentry();
      initJobSentry();

      expect(init).toHaveBeenCalledTimes(1);
    });

    it("does not throw if Sentry setup throws", () => {
      const { initJobSentry } = loadModule();
      init.mockImplementation(() => {
        throw new Error("bad DSN");
      });

      expect(() => initJobSentry()).not.toThrow();
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining("init failed"),
        expect.any(Error),
      );
    });
  });

  describe("does not ship a developer's local run to production Sentry", () => {
    // A background process has no NODE_ENV, so the gate keys off the Sentry
    // environment instead.
    const asProcessWithoutNodeEnv = () => {
      delete (process.env as Record<string, string | undefined>).NODE_ENV;
      process.env.NEXT_PUBLIC_SENTRY_DSN = "https://key@example.test/1";
    };

    it("stays disabled for a local run with no NODE_ENV and a development environment", () => {
      asProcessWithoutNodeEnv();
      process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT = "development";

      loadModule().initJobSentry();

      expect(lastInitOptions().enabled).toBe(false);
    });

    it("stays disabled when the Sentry environment is not set at all", () => {
      asProcessWithoutNodeEnv();
      delete process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT;

      loadModule().initJobSentry();

      expect(lastInitOptions().enabled).toBe(false);
    });

    it("is enabled when the Sentry environment is production", () => {
      asProcessWithoutNodeEnv();
      process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT = "production";

      loadModule().initJobSentry();

      expect(lastInitOptions().enabled).toBe(true);
    });

    it("stays disabled in a deployed environment with no DSN", () => {
      // The job gate only ever NARROWS what the shared config decided.
      asProcessWithoutNodeEnv();
      delete process.env.NEXT_PUBLIC_SENTRY_DSN;
      process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT = "production";

      loadModule().initJobSentry();

      expect(lastInitOptions().enabled).toBe(false);
    });

    it("pins the trace sample rate instead of inheriting the NODE_ENV default", () => {
      // Without this, an unset NODE_ENV resolves to 100% sampling while the
      // events report environment: production.
      asProcessWithoutNodeEnv();
      process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT = "production";

      loadModule().initJobSentry();

      expect(lastInitOptions().tracesSampleRate).toBe(0);
    });
  });

  describe("flushJobSentry", () => {
    it("flushes with the default timeout", async () => {
      const { flushJobSentry, JOB_FLUSH_TIMEOUT_MS } = loadModule();

      await flushJobSentry();

      expect(flush).toHaveBeenCalledTimes(1);
      expect(flush).toHaveBeenCalledWith(JOB_FLUSH_TIMEOUT_MS);
      expect(consoleWarn).not.toHaveBeenCalled();
    });

    it("honours a custom timeout", async () => {
      const { flushJobSentry } = loadModule();

      await flushJobSentry(30_000);

      expect(flush).toHaveBeenCalledWith(30_000);
    });

    it("does not reject when the transport throws", async () => {
      const { flushJobSentry } = loadModule();
      flush.mockImplementation(async () => {
        throw new Error("network down");
      });

      await expect(flushJobSentry()).resolves.toBeUndefined();
      expect(consoleWarn).toHaveBeenCalledWith(
        expect.stringContaining("flush failed"),
        expect.any(Error),
      );
    });

    it("warns when the drain times out, which resolves false rather than throwing", async () => {
      const { flushJobSentry } = loadModule();
      flush.mockImplementation(async () => false);

      await expect(flushJobSentry(1_000)).resolves.toBeUndefined();

      expect(consoleWarn).toHaveBeenCalledWith(
        expect.stringContaining("flush timed out after 1000ms"),
      );
    });
  });
});
