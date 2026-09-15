/**
 * @jest-environment node
 */

/**
 * #1654 — the Novu trigger outbox. Pins: stage + attempt marks the row SENT
 * under the transactionId the wire call carried; a timeout leaves it PENDING;
 * the drain's query skips a `notBefore` still in the future; and
 * deriveTransactionId is stable and locale-independent for mixed-case keys.
 */

const mockTrigger = jest.fn();
const mockUpsert = jest.fn();
const mockUpdate = jest.fn();
const mockCaptureException = jest.fn();

jest.mock("../../lib/novu/client", () => ({
  isNovuConfigured: () => true,
  getNovuClient: () => ({
    trigger: (...args: unknown[]) => mockTrigger(...args),
    triggerBroadcast: jest.fn(),
  }),
}));

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    notificationOutbox: {
      upsert: (...args: unknown[]) => mockUpsert(...args),
      update: (...args: unknown[]) => mockUpdate(...args),
    },
  },
}));

jest.mock("@sentry/nextjs", () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
  captureMessage: jest.fn(),
}));

import {
  attemptTrigger,
  deriveTransactionId,
  stageTrigger,
} from "@/lib/novu/outbox";
import {
  runNotificationDrainTick,
  type NotificationOutboxStore,
} from "@/jobs/notifications/drain-notification-outbox";

const payload = {
  appointmentId: "appt-1",
  dashboardUrl: "/dashboard",
  consultantName: "Asha",
};

afterEach(() => jest.clearAllMocks());

describe("stageTrigger + attemptTrigger", () => {
  it("stages the row, then a successful attempt marks it SENT under the same transactionId", async () => {
    const transactionId = deriveTransactionId(
      "appointment-booked",
      ["u2", "u1"],
      payload,
    );
    mockUpsert.mockImplementation(async (args) => ({
      id: "nx-1",
      ...args.create,
    }));
    mockTrigger.mockResolvedValue({});
    mockUpdate.mockResolvedValue({});

    const staged = await stageTrigger({
      workflowId: "appointment-booked",
      kind: "MULTI",
      recipients: ["u2", "u1"],
      payload,
      entityRef: "appointment:appt-1",
    });

    expect(mockUpsert.mock.calls[0][0]).toMatchObject({
      where: { transactionId },
      create: { status: "PENDING", entityRef: "appointment:appt-1" },
      update: {},
    });

    const result = await attemptTrigger(staged!);
    expect(result).toEqual({ success: true, outcome: "SENT" });
    expect(mockTrigger.mock.calls[0][0]).toMatchObject({
      to: ["u2", "u1"],
      transactionId,
    });
    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: "nx-1" },
      data: expect.objectContaining({ status: "SENT", lastError: null }),
    });
  });

  it("leaves the row PENDING with the cause on a timeout, for the drain to finish", async () => {
    const timeout = new Error("Request timed out");
    timeout.name = "RequestTimeoutError";
    mockTrigger.mockRejectedValue(timeout);
    mockUpdate.mockResolvedValue({});

    const result = await attemptTrigger({
      id: "nx-2",
      workflowId: "appointment-booked",
      kind: "SINGLE",
      recipients: ["u1"],
      payload,
      transactionId: "appointment-booked:abc",
      attempts: 0,
      status: "PENDING",
    });

    expect(result).toMatchObject({ success: false, outcome: "PENDING" });
    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: "nx-2" },
      data: { lastError: "Request timed out" },
    });
    // Transient: a warning, never a terminal page.
    expect(mockCaptureException.mock.calls[0][1]).toMatchObject({
      level: "warning",
    });
  });
});

describe("runNotificationDrainTick", () => {
  it("asks only for rows whose notBefore has passed", async () => {
    const now = new Date("2026-09-15T09:00:00Z");
    const findMany = jest.fn().mockResolvedValue([]);
    const store: NotificationOutboxStore = {
      notificationOutbox: { findMany },
    };

    const result = await runNotificationDrainTick({
      prisma: store,
      now: () => now.getTime(),
      attempt: jest.fn(),
    });

    expect(result.scanned).toBe(0);
    expect(findMany.mock.calls[0][0].where).toEqual({
      AND: [
        {
          OR: [
            { status: "PENDING" },
            { status: "RETRY", nextRetryAt: { lte: now } },
          ],
        },
        { OR: [{ notBefore: null }, { notBefore: { lte: now } }] },
      ],
    });
  });
});

describe("deriveTransactionId", () => {
  it("is stable and locale-independent for mixed-case recipient ids and payload keys", () => {
    // Code-point order puts every upper-case letter before every lower-case
    // one, which is what a locale-aware sort does NOT do; the expectation is
    // hand-computed from that order, so a localeCompare regression fails it.
    const id = deriveTransactionId("wf", ["b", "B", "a", "A"], {
      zeta: 1,
      Alpha: 2,
      beta: 3,
    });
    const { createHash } =
      jest.requireActual<typeof import("node:crypto")>("node:crypto");
    const expected = createHash("sha256")
      .update(`wf|A,B,a,b|${JSON.stringify({ Alpha: 2, beta: 3, zeta: 1 })}`)
      .digest("hex")
      .slice(0, 32);
    expect(id).toBe(`wf:${expected}`);
    expect(
      deriveTransactionId("wf", ["A", "a", "B", "b"], {
        beta: 3,
        zeta: 1,
        Alpha: 2,
      }),
    ).toBe(id);
  });
});
