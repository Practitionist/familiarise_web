/**
 * FAMILIARISE_WEB-36 — `reportSentryError` turned a thrown plain object (the
 * Razorpay SDK's `{ statusCode, error: { code, description } }`) into
 * `Error: [object Object]`. It should instead surface the object's own
 * description/message/code, alongside the statusCode.
 */

const captureException = jest.fn();
jest.mock("@sentry/nextjs", () => ({
  captureException: (...args: unknown[]) => captureException(...args),
  captureMessage: jest.fn(),
}));

import { reportSentryError } from "../../lib/observability/report";

beforeEach(() => {
  jest.clearAllMocks();
});

describe("reportSentryError normalises a thrown value before capture", () => {
  it("falls back to a nested error.message when the provider sends no description", () => {
    reportSentryError(
      { error: { message: "Gateway timed out" } },
      { subsystem: "payments", op: "x" },
    );
    const captured = captureException.mock.calls[0]?.[0] as Error;
    expect(captured.message).toContain("Gateway timed out");
    expect(captured.message).not.toContain("{");
  });

  it("reports a thrown Razorpay-shaped object by its description, not [object Object]", () => {
    reportSentryError(
      {
        statusCode: 400,
        error: {
          code: "BAD_REQUEST_ERROR",
          description: "The id provided does not exist",
        },
      },
      { subsystem: "payments", op: "x" },
    );

    expect(captureException).toHaveBeenCalledTimes(1);
    const captured = captureException.mock.calls[0]?.[0] as Error;
    expect(captured).toBeInstanceOf(Error);
    expect(captured.message).toContain("The id provided does not exist");
    expect(captured.message).toContain("400");
  });

  it("captures a thrown string verbatim", () => {
    reportSentryError("connection terminated", { subsystem: "payments" });

    const captured = captureException.mock.calls[0]?.[0] as Error;
    expect(captured).toBeInstanceOf(Error);
    expect(captured.message).toBe("connection terminated");
  });

  it("passes an Error instance through unchanged", () => {
    const original = new Error("already an error");

    reportSentryError(original, { subsystem: "payments" });

    const captured = captureException.mock.calls[0]?.[0] as Error;
    expect(captured).toBe(original);
  });
});

describe("pool exhaustion is tagged centrally (#1696)", () => {
  it("stamps pool_exhaustion on P2024 and on the interactive-transaction timeout text", () => {
    reportSentryError(
      Object.assign(new Error("Timed out fetching a new connection"), {
        code: "P2024",
      }),
      { subsystem: "bookings" },
    );
    reportSentryError(
      new Error("Unable to start a transaction in the given time."),
      { subsystem: "bookings" },
    );
    reportSentryError(new Error("slot taken"), { subsystem: "bookings" });

    const tagsOf = (i: number) =>
      (captureException.mock.calls[i]?.[1] as { tags: Record<string, string> })
        .tags;
    expect(tagsOf(0).pool_exhaustion).toBe("true");
    expect(tagsOf(1).pool_exhaustion).toBe("true");
    expect(tagsOf(2).pool_exhaustion).toBeUndefined();
  });
});
