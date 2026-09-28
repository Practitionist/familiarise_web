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

import {
  reportAuthLogToSentry,
  __resetAuthLoggerThrottleForTests,
} from "../../lib/auth/auth-logger";

beforeEach(() => {
  jest.clearAllMocks();
  __resetAuthLoggerThrottleForTests();
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

  // --- review follow-up (#1876). better-auth@1.6.5 logs these at
  // `error` even though they are authentication OUTCOMES. Forwarding them
  // turned every mistyped password into a billed, paging Sentry event on
  // an unauthenticated surface, against a 5,000-error monthly quota.

  it.each([
    ["Invalid password", undefined],
    ["User not found", { email: "victim@example.com" }],
    ["Credential account not found", { email: "victim@example.com" }],
    ["Password not found", { email: "victim@example.com" }],
    ["Failed to create session", undefined],
  ])("does not send an auth outcome to Sentry (%s)", (message, args) => {
    reportAuthLogToSentry("error", message, ...(args ? [args] : []));

    expect(captureException).not.toHaveBeenCalled();
    expect(captureMessage).not.toHaveBeenCalled();
    // The Netlify function log keeps it — that is the signal an
    // operator greps during an incident, and it never leaves the box.
    expect(consoleError).toHaveBeenCalledWith(
      `[Better Auth]: ${message}`,
      ...(args ? [args] : []),
    );
  });

  it("never sends the submitted email to Sentry", () => {
    reportAuthLogToSentry("error", "User not found", {
      email: "victim@example.com",
    });

    // The sink forwards only the message string, never `args`. If a
    // future edit starts passing `args` through, the address reaches
    // Sentry and the quota event becomes a PII event too.
    for (const call of [
      ...captureMessage.mock.calls,
      ...captureException.mock.calls,
    ]) {
      expect(JSON.stringify(call)).not.toContain("victim@example.com");
    }
  });

  it("trickles the message-shaped branch instead of firing per request", () => {
    // The schema-error branch fires once per affected request. During a
    // bad push that is one event per sign-in attempt, which is the exact
    // repetition class the quota guard exists for.
    reportAuthLogToSentry("error", "column deviceLabel does not exist");
    reportAuthLogToSentry("error", "column deviceLabel does not exist");
    reportAuthLogToSentry("error", "column deviceLabel does not exist");

    expect(captureMessage).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledTimes(3);
  });

  it("throttles per distinct message, so one class cannot mask another", () => {
    reportAuthLogToSentry("error", "column deviceLabel does not exist");
    reportAuthLogToSentry("error", "column lastSeenAt does not exist");

    expect(captureMessage).toHaveBeenCalledTimes(2);
  });

  it("still forwards a real Error whose message reads like an auth outcome", () => {
    // The denylist matches the MESSAGE, never the error's text. A thrown
    // exception is a fault whatever it says.
    const err = new Error("Invalid password");

    reportAuthLogToSentry("error", "INTERNAL_SERVER_ERROR", err);

    expect(captureException).toHaveBeenCalledWith(
      err,
      expect.objectContaining({ tags: { subsystem: "auth" } }),
    );
  });
});
