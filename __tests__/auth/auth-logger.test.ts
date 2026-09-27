/**
 * @jest-environment node
 */

/**
 * BetterAuth → Sentry bridge (#1856). Before this, endpoint exceptions
 * died inside better-call as 500 responses and schema errors
 * (`"no column"`…) took a message-only log branch — nothing ever
 * reached Sentry, which is why the pre-push sign-in 500s were silent.
 */

const captureException = jest.fn();
const captureMessage = jest.fn();
jest.mock("@sentry/nextjs", () => ({
  __esModule: true,
  captureException: (...a: unknown[]) => captureException(...a),
  captureMessage: (...a: unknown[]) => captureMessage(...a),
}));

const consoleError = jest.fn();
const consoleWarn = jest.fn();
const consoleLog = jest.fn();

import { reportAuthLogToSentry } from "../../lib/auth/auth-logger";

beforeEach(() => {
  jest.clearAllMocks();
  jest
    .spyOn(console, "error")
    .mockImplementation((...a: unknown[]) => consoleError(...a));
  jest
    .spyOn(console, "warn")
    .mockImplementation((...a: unknown[]) => consoleWarn(...a));
  jest
    .spyOn(console, "log")
    .mockImplementation((...a: unknown[]) => consoleLog(...a));
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("reportAuthLogToSentry (#1856)", () => {
  it("forwards an Error with its stack and keeps console output", () => {
    const err = new Error("column does not exist");

    reportAuthLogToSentry("error", "INTERNAL_SERVER_ERROR", err);

    expect(consoleError).toHaveBeenCalledWith(
      "[Better Auth]: INTERNAL_SERVER_ERROR",
      err,
    );
    expect(captureException).toHaveBeenCalledWith(
      err,
      expect.objectContaining({ tags: { subsystem: "auth" } }),
    );
    expect(captureMessage).not.toHaveBeenCalled();
  });

  it("captures the message string when no Error object rides along (the schema-error branch)", () => {
    reportAuthLogToSentry("error", "column deviceLabel does not exist");

    expect(captureException).not.toHaveBeenCalled();
    expect(captureMessage).toHaveBeenCalledWith(
      "[better-auth] column deviceLabel does not exist",
      expect.objectContaining({
        tags: { subsystem: "auth" },
        level: "error",
      }),
    );
  });

  it("never sends warn/debug/info to Sentry, only to console", () => {
    reportAuthLogToSentry("warn", "low-entropy secret");
    reportAuthLogToSentry("info", "boot");
    reportAuthLogToSentry("debug", "detail");

    expect(captureException).not.toHaveBeenCalled();
    expect(captureMessage).not.toHaveBeenCalled();
    expect(consoleWarn).toHaveBeenCalledTimes(1);
    expect(consoleLog).toHaveBeenCalledTimes(2);
  });
});
