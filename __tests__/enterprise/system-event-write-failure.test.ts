/**
 * @jest-environment node
 */

/**
 * A failed `system_events` insert must reach the `*Safe` wrappers.
 *
 * `recordSystemEvent` swallows an insert failure unless `strict` is set, so the
 * wrappers — whose whole purpose is to report that the money-path audit record
 * could not be written — never saw it. They only ever saw a *thrown* error,
 * which the insert path does not produce. The fix re-throws to the wrapper and
 * only the wrapper, so every other caller keeps its never-reject contract.
 *
 * The report must also be safe to ship: a Prisma error's `message` and `meta`
 * can carry constraint text, column values, or a connection string, so only the
 * operation and the error class go into the event.
 */

const captureException = jest.fn();

jest.mock("@sentry/nextjs", () => ({
  captureException: (...args: unknown[]) => captureException(...args),
  captureMessage: jest.fn(),
  withScope: jest.fn((cb: (scope: unknown) => void) =>
    cb({
      setTag: jest.fn(),
      setContext: jest.fn(),
      setExtra: jest.fn(),
      setLevel: jest.fn(),
    }),
  ),
}));

jest.mock("../../lib/prisma", () => {
  const client = { systemEvent: { create: jest.fn() } };
  return { __esModule: true, default: client };
});

import prisma from "../../lib/prisma";
import {
  recordSystemEvent,
  recordSystemEventSafe,
  recordSystemErrorSafe,
  SYSTEM_EVENT_WRITE_FAILURE_MARKER,
} from "../../lib/enterprise/system-events";

const create = prisma.systemEvent.create as unknown as jest.Mock;

function sentEvents() {
  return captureException.mock.calls.map(([err, hint]) => ({
    message: (err as Error).message,
    hint: hint as {
      tags?: Record<string, string>;
      extra?: Record<string, unknown>;
    },
  }));
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("system event write-failure reporting", () => {
  it("recordSystemEvent swallows the insert failure for a plain caller", async () => {
    create.mockRejectedValueOnce(new Error("db down"));
    await expect(
      recordSystemEvent({ category: "OVERAGE", message: "hello" }),
    ).resolves.toBeUndefined();
    // The legacy contract is unchanged: a table outage must not cascade into
    // the calling worker.
    expect(sentEvents()).toHaveLength(0);
  });

  it("recordSystemEventSafe reports a swallowed insert failure", async () => {
    create.mockRejectedValueOnce(new Error("db down"));
    await expect(
      recordSystemEventSafe({ category: "OVERAGE", message: "hello" }),
    ).resolves.toBeUndefined();

    const events = sentEvents();
    expect(events).toHaveLength(1);
    expect(events[0].message).toContain(SYSTEM_EVENT_WRITE_FAILURE_MARKER);
    expect(events[0].message).toContain("recordSystemEvent");
    expect(events[0].hint.tags?.expected).toBe("true");
  });

  it("recordSystemErrorSafe reports a swallowed insert failure from its inner call", async () => {
    // recordSystemError delegates to recordSystemEvent, so the flag has to
    // survive that hop or the error wrapper is blind too.
    create.mockRejectedValueOnce(new Error("db down"));
    await expect(
      recordSystemErrorSafe({
        category: "PAYOUT",
        summary: "batch failed",
        err: new Error("boom"),
      }),
    ).resolves.toBeUndefined();

    const events = sentEvents();
    expect(events).toHaveLength(1);
    expect(events[0].message).toContain("recordSystemError");
  });

  it("does not ship the raw error object or its message to Sentry", async () => {
    const secret = new Error(
      "connect ECONNREFUSED postgres://user:hunter2@10.0.0.5:5432/familiarise",
    );
    create.mockRejectedValueOnce(secret);
    await recordSystemEventSafe({ category: "OVERAGE", message: "hello" });

    const [event] = sentEvents();
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain("hunter2");
    expect(serialized).not.toContain("10.0.0.5");
    // The class survives, which is what makes the report triageable.
    expect(event.message).toContain("Error");
    expect(event.hint.extra?.errorClass).toBe("Error");
  });

  it("reports a non-Error rejection without serializing it wholesale", async () => {
    create.mockRejectedValueOnce({ password: "hunter2", code: "P1001" });
    await recordSystemEventSafe({ category: "OVERAGE", message: "hello" });

    const [event] = sentEvents();
    expect(JSON.stringify(event)).not.toContain("hunter2");
    expect(event.hint.extra?.operation).toBe("recordSystemEvent");
  });

  it("stays quiet on a successful write", async () => {
    create.mockResolvedValueOnce({ id: "evt_1" });
    await recordSystemEventSafe({ category: "OVERAGE", message: "hello" });
    expect(sentEvents()).toHaveLength(0);
  });
});
