/**
 * @jest-environment node
 */

/**
 * The Novu trigger outbox. Pins: stage + attempt sends one bulk event per
 * currently-allowed recipient under a stable per-recipient transactionId and
 * marks the row SENT only when Novu accepted every event; a timeout leaves it
 * PENDING; revoked audiences, the replay window and Novu 409 settle the way
 * the relay expects; every status write is conditional so nothing overwrites
 * SENT; and the drain takes urgent workflows first.
 */

const mockTriggerBulk = jest.fn();
const mockUpsert = jest.fn();
const mockUpdateMany = jest.fn();
const mockFindUnique = jest.fn();
const mockUserFindMany = jest.fn();
const mockCaptureException = jest.fn();
const mockPostOpsChat = jest.fn();

jest.mock("../../lib/novu/client", () => ({
  isNovuConfigured: () => true,
  getNovuClient: () => ({
    triggerBulk: (...args: unknown[]) => mockTriggerBulk(...args),
    triggerBroadcast: jest.fn(),
  }),
}));

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    notificationOutbox: {
      upsert: (...args: unknown[]) => mockUpsert(...args),
      updateMany: (...args: unknown[]) => mockUpdateMany(...args),
      findUnique: (...args: unknown[]) => mockFindUnique(...args),
    },
    user: {
      findMany: (...args: unknown[]) => mockUserFindMany(...args),
    },
  },
}));

jest.mock("../../lib/observability/ops-chat", () => ({
  postOpsChat: (...args: unknown[]) => mockPostOpsChat(...args),
}));

jest.mock("@sentry/core", () => jest.requireMock("@sentry/nextjs"));
jest.mock("@sentry/nextjs", () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
  captureMessage: jest.fn(),
}));

import {
  attemptTrigger,
  deriveTransactionId,
  outboxTransactionIdOf,
  PROVIDER_REPLAY_WINDOW_MS,
  recipientTransactionId,
  stageTrigger,
  terminalTriggerReason,
  type StagedTrigger,
} from "@/lib/novu/outbox";
import {
  runNotificationDrainTick,
  URGENT_WORKFLOWS,
  type NotificationOutboxStore,
} from "@/jobs/notifications/drain-notification-outbox";
import { notifyPayoutFailed } from "@/lib/novu/service";

const payload = {
  appointmentId: "appt-1",
  dashboardUrl: "/dashboard",
  consultantName: "Asha",
};

const ACTIVE = { in: ["PENDING", "RETRY"] };

function row(overrides: Partial<StagedTrigger> = {}): StagedTrigger {
  return {
    id: "nx-1",
    workflowId: "appointment-booked",
    kind: "SINGLE",
    recipients: ["u1"],
    payload,
    transactionId: `appointment-booked:${"a".repeat(32)}`,
    attempts: 0,
    status: "PENDING",
    notBefore: null,
    firstAttemptAt: null,
    ...overrides,
  };
}

const allowed = (id: string) => ({
  id,
  erasedAt: null,
  orgWorkspaceProfile: null,
  notificationPreferences: { allNotifications: true, inAppEnabled: true },
});
const inAppOff = (id: string) => ({
  ...allowed(id),
  notificationPreferences: { allNotifications: true, inAppEnabled: false },
});

const processed = { acknowledged: true, status: "processed" };

/** Every bulk event the client was asked to send, in call order. */
function sentEvents(): Array<{ to: string; transactionId: string }> {
  return mockTriggerBulk.mock.calls.flatMap(
    ([body]: [{ events: Array<{ to: string; transactionId: string }> }]) =>
      body.events,
  );
}

/** The `data` of the updateMany that settled the row (not the stamp). */
function settleData(): Record<string, unknown> | undefined {
  const settle = mockUpdateMany.mock.calls.find(
    ([args]: [{ data: Record<string, unknown> }]) =>
      !("firstAttemptAt" in args.data),
  );
  return settle?.[0].data;
}

beforeEach(() => {
  mockUpdateMany.mockResolvedValue({ count: 1 });
  mockUserFindMany.mockImplementation(
    async (args: { where: { id: { in: string[] } } }) =>
      args.where.id.in.map(allowed),
  );
  mockTriggerBulk.mockImplementation(async (body: { events: unknown[] }) => ({
    headers: {},
    result: body.events.map(() => processed),
  }));
});
afterEach(() => jest.clearAllMocks());

describe("stageTrigger + attemptTrigger", () => {
  it("stages the row, then sends one bulk event per recipient and marks it SENT conditionally", async () => {
    const transactionId = deriveTransactionId(
      "appointment-booked",
      ["u2", "u1"],
      payload,
    );
    mockUpsert.mockImplementation(async (args) => ({
      id: "nx-1",
      ...args.create,
    }));

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
    expect(sentEvents()).toEqual([
      expect.objectContaining({
        to: "u2",
        transactionId: recipientTransactionId(transactionId, "u2"),
      }),
      expect.objectContaining({
        to: "u1",
        transactionId: recipientTransactionId(transactionId, "u1"),
      }),
    ]);
    // Idempotency-Key: an SDK retry of an accepted bulk must not ring twice.
    expect(mockTriggerBulk.mock.calls[0][1]).toMatch(
      new RegExp(`^${transactionId}:bulk:[0-9a-f]{16}$`),
    );
    // firstAttemptAt is claimed before the provider call, only while active.
    expect(mockUpdateMany.mock.calls[0][0]).toEqual({
      where: { id: "nx-1", status: ACTIVE, firstAttemptAt: null },
      data: { firstAttemptAt: expect.any(Date) },
    });
    expect(mockUpdateMany).toHaveBeenLastCalledWith({
      where: { id: "nx-1", status: ACTIVE },
      data: expect.objectContaining({ status: "SENT", lastError: null }),
    });
  });

  it("leaves the row PENDING with the cause on a timeout, for the drain to finish", async () => {
    const timeout = new Error("Request timed out");
    timeout.name = "RequestTimeoutError";
    mockTriggerBulk.mockRejectedValue(timeout);

    const result = await attemptTrigger(row({ id: "nx-2" }));

    expect(result).toMatchObject({ success: false, outcome: "PENDING" });
    expect(mockUpdateMany).toHaveBeenLastCalledWith({
      where: { id: "nx-2", status: ACTIVE },
      data: { lastError: "Request timed out" },
    });
    // Transient: a warning, never a terminal page.
    expect(mockCaptureException.mock.calls[0][1]).toMatchObject({
      level: "warning",
    });
  });

  it("holds a row whose notBefore is in the future for the drain", async () => {
    const result = await attemptTrigger(
      row({ notBefore: new Date(Date.now() + 60 * 60 * 1000) }),
    );

    expect(result).toMatchObject({ success: true, outcome: "PENDING" });
    expect(mockTriggerBulk).not.toHaveBeenCalled();
    expect(mockUpdateMany).not.toHaveBeenCalled();
  });
});

describe("attempt-time recipient policy", () => {
  it("sends only to recipients still allowed, under the same per-recipient ids on every attempt", async () => {
    const multi = row({ kind: "MULTI", recipients: ["u1", "u2", "u3"] });
    mockUserFindMany.mockResolvedValue([
      allowed("u1"),
      inAppOff("u2"),
      allowed("u3"),
    ]);
    mockTriggerBulk.mockRejectedValueOnce(new Error("socket hang up"));

    await attemptTrigger(multi, { relay: true });
    await attemptTrigger(
      { ...multi, status: "RETRY", attempts: 1, firstAttemptAt: new Date() },
      { relay: true },
    );

    const expected = ["u1", "u3"].map((to) =>
      expect.objectContaining({
        to,
        transactionId: recipientTransactionId(multi.transactionId, to),
      }),
    );
    expect(sentEvents()).toEqual([...expected, ...expected]);
    expect(mockTriggerBulk.mock.calls[1][1]).toBe(
      mockTriggerBulk.mock.calls[0][1],
    );
    expect(settleData()).toMatchObject({ status: "RETRY" });
    expect(mockUpdateMany).toHaveBeenLastCalledWith({
      where: { id: multi.id, status: ACTIVE },
      data: expect.objectContaining({ status: "SENT" }),
    });
  });

  it("dead-letters as an expected skip when nobody may receive it, and never calls Novu", async () => {
    mockUserFindMany.mockResolvedValue([
      { ...allowed("u1"), erasedAt: new Date() },
    ]);

    const result = await attemptTrigger(row());

    expect(result).toEqual({
      success: true,
      outcome: "DEAD_LETTER",
      deadLetterReason: "policy:audience_revoked",
    });
    expect(mockTriggerBulk).not.toHaveBeenCalled();
    expect(mockUpdateMany).toHaveBeenCalledWith({
      where: { id: "nx-1", status: ACTIVE },
      data: expect.objectContaining({
        status: "DEAD_LETTER",
        lastError: "policy:audience_revoked",
      }),
    });
  });

  it("treats a recipient whose user row is gone as revoked at the attempt", async () => {
    mockUserFindMany.mockResolvedValue([]);

    const result = await attemptTrigger(row());

    expect(result).toMatchObject({
      outcome: "DEAD_LETTER",
      deadLetterReason: "policy:audience_revoked",
    });
    expect(mockTriggerBulk).not.toHaveBeenCalled();
  });

  it("never sends when the policy read fails; the row waits for a later attempt", async () => {
    mockUserFindMany.mockRejectedValue(new Error("db down"));

    const result = await attemptTrigger(row(), { relay: true });

    expect(result).toMatchObject({ success: false, outcome: "PENDING" });
    expect(mockTriggerBulk).not.toHaveBeenCalled();
    expect(mockUpdateMany).not.toHaveBeenCalled();
  });
});

describe("bulk results and failure classes", () => {
  it("retries a Novu 409 (same key still in flight) instead of dead-lettering", async () => {
    expect(terminalTriggerReason(409, "in progress")).toBeNull();
    mockTriggerBulk.mockRejectedValue(
      Object.assign(new Error("Conflict"), { statusCode: 409, body: "" }),
    );

    const result = await attemptTrigger(row(), { relay: true });

    expect(result).toMatchObject({ success: false, outcome: "RETRY" });
    expect(settleData()).toMatchObject({ status: "RETRY", attempts: 1 });
  });

  it("retries when Novu refused one event, and counts a duplicate transactionId as delivered", async () => {
    const multi = row({ kind: "MULTI", recipients: ["u1", "u2"] });
    mockTriggerBulk.mockResolvedValueOnce({
      headers: {},
      result: [processed, { acknowledged: true, status: "error" }],
    });

    await expect(attemptTrigger(multi, { relay: true })).resolves.toMatchObject(
      { outcome: "RETRY" },
    );

    mockUpdateMany.mockClear();
    mockTriggerBulk.mockResolvedValueOnce({
      headers: {},
      result: [
        {
          acknowledged: true,
          status: "error",
          error: ["transactionId property is not unique"],
        },
        processed,
      ],
    });
    await expect(
      attemptTrigger(
        { ...multi, status: "RETRY", attempts: 1, firstAttemptAt: new Date() },
        { relay: true },
      ),
    ).resolves.toEqual({ success: true, outcome: "SENT" });
  });

  it("dead-letters a terminal per-event status and pages", async () => {
    mockTriggerBulk.mockResolvedValue({
      headers: {},
      result: [{ acknowledged: true, status: "trigger_not_active" }],
    });

    const result = await attemptTrigger(row(), { relay: true });

    expect(result).toMatchObject({ success: false, outcome: "DEAD_LETTER" });
    expect(mockCaptureException.mock.calls[0][1]).toMatchObject({
      level: "error",
      fingerprint: ["novu-trigger-terminal", "novu_trigger_not_active"],
    });
  });
});

describe("conditional writes and the replay window", () => {
  it("does not send when a concurrent attempt already settled the row SENT", async () => {
    mockUpdateMany.mockResolvedValueOnce({ count: 0 });
    mockFindUnique.mockResolvedValue({ status: "SENT", firstAttemptAt: null });

    const result = await attemptTrigger(row(), { relay: true });

    expect(result).toEqual({ success: true, outcome: "SENT" });
    expect(mockTriggerBulk).not.toHaveBeenCalled();
    expect(mockUpdateMany).toHaveBeenCalledTimes(1);
  });

  it("guards every settle on an active status, so a late failure cannot overwrite SENT", async () => {
    mockTriggerBulk.mockRejectedValue(
      Object.assign(new Error("Bad"), { statusCode: 400, body: "" }),
    );

    await attemptTrigger(row(), { relay: true });

    for (const [args] of mockUpdateMany.mock.calls) {
      expect(args.where).toMatchObject({ id: "nx-1", status: ACTIVE });
    }
    expect(settleData()).toMatchObject({ status: "DEAD_LETTER" });
  });

  it("sends a row Novu never saw, however old", async () => {
    const result = await attemptTrigger(
      row({ createdAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000) }),
      { relay: true },
    );

    expect(result).toEqual({ success: true, outcome: "SENT" });
    expect(mockTriggerBulk).toHaveBeenCalledTimes(1);
  });

  it("sends a row first attempted a replay window ago to review instead of retrying it", async () => {
    const result = await attemptTrigger(
      row({
        status: "RETRY",
        attempts: 2,
        firstAttemptAt: new Date(Date.now() - PROVIDER_REPLAY_WINDOW_MS),
      }),
      { relay: true },
    );

    expect(result).toMatchObject({
      success: false,
      outcome: "DEAD_LETTER",
      deadLetterReason: "review:provider_acceptance_unknown",
    });
    expect(mockTriggerBulk).not.toHaveBeenCalled();
  });
});

describe("runNotificationDrainTick", () => {
  const now = new Date("2026-09-15T09:00:00Z");
  const due = {
    AND: [
      {
        OR: [
          {
            status: "PENDING",
            OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: now } }],
          },
          { status: "RETRY", nextRetryAt: { lte: now } },
        ],
      },
      { OR: [{ notBefore: null }, { notBefore: { lte: now } }] },
    ],
  };

  it("asks for due urgent rows first, then fills the batch with routine ones", async () => {
    const urgent = row({ id: "urgent", workflowId: "payment-failed" });
    const routine = row({ id: "routine" });
    const findMany = jest
      .fn()
      .mockResolvedValueOnce([urgent])
      .mockResolvedValueOnce([routine]);
    const store: NotificationOutboxStore = {
      notificationOutbox: { findMany },
    };
    const attempt = jest.fn().mockResolvedValue({ outcome: "SENT" });

    const result = await runNotificationDrainTick({
      prisma: store,
      now: () => now.getTime(),
      maxBatch: 10,
      attempt,
    });

    expect(findMany.mock.calls[0][0]).toMatchObject({
      where: { AND: [due, { workflowId: { in: [...URGENT_WORKFLOWS] } }] },
      take: 10,
    });
    expect(findMany.mock.calls[1][0]).toMatchObject({
      where: { AND: [due, { workflowId: { notIn: [...URGENT_WORKFLOWS] } }] },
      take: 9,
    });
    expect(attempt.mock.calls.map(([r]) => r.id)).toEqual([
      "urgent",
      "routine",
    ]);
    expect(result.sent).toBe(2);
  });

  it("counts an expected policy skip without alerting on it", async () => {
    const findMany = jest
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([row()]);
    const attempt = jest.fn().mockResolvedValue({
      success: true,
      outcome: "DEAD_LETTER",
      deadLetterReason: "policy:audience_revoked",
    });

    const result = await runNotificationDrainTick({
      prisma: { notificationOutbox: { findMany } },
      now: () => now.getTime(),
      attempt,
    });

    expect(result.deadLettered).toBe(1);
    expect(mockCaptureException).not.toHaveBeenCalled();
    expect(mockPostOpsChat).not.toHaveBeenCalled();
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

  it("keys identical payloads apart by dedupeKey (refund-requested uses the refund row id)", () => {
    // The refund-requested wire payload carries no refund id, so two refunds
    // of the same amount/reason/scope must be told apart by the key; the same
    // key still collapses a retry onto one row.
    const payload = { amount: "₹500", currency: "INR", scope: "b2c" };
    const a = deriveTransactionId(
      "refund-requested",
      ["ops1"],
      payload,
      "rf_1",
    );
    const b = deriveTransactionId(
      "refund-requested",
      ["ops1"],
      payload,
      "rf_2",
    );
    expect(a).not.toBe(b);
    expect(
      deriveTransactionId("refund-requested", ["ops1"], payload, "rf_1"),
    ).toBe(a);
  });

  it("maps a per-recipient Novu id back to its row and leaves a row id alone", () => {
    const rowId = deriveTransactionId("wf", ["u1", "u2"], payload);
    expect(outboxTransactionIdOf(recipientTransactionId(rowId, "u1"))).toBe(
      rowId,
    );
    expect(outboxTransactionIdOf(rowId)).toBe(rowId);
    expect(recipientTransactionId(rowId, "u1")).not.toBe(
      recipientTransactionId(rowId, "u2"),
    );
  });

  it("derives entityRef from payload when omitted and sets a 60s inline lease on nextRetryAt", async () => {
    const before = Date.now();
    mockUpsert.mockImplementation(async (args) => ({
      id: "nx-lease",
      ...args.create,
    }));

    await stageTrigger({
      workflowId: "appointment-booked",
      kind: "SINGLE",
      recipients: ["u1"],
      payload: { appointmentId: "appt-42", dashboardUrl: "/d" },
    });

    const createArg = mockUpsert.mock.calls[0][0].create as {
      entityRef: string;
      nextRetryAt: Date;
    };
    expect(createArg.entityRef).toBe("appointment:appt-42");
    expect(createArg.nextRetryAt.getTime()).toBeGreaterThanOrEqual(
      before + 59_000,
    );
  });

  it("strips NovuError.body/rawValue before Sentry capture and tags outbox_dead_letter on exhausted retries", async () => {
    const novuErr = Object.assign(new Error("Unprocessable Entity"), {
      name: "NovuError",
      statusCode: 503,
      body: '{"subscriber":{"email":"secret@example.com"}}',
      rawValue: { email: "secret@example.com" },
    });
    mockTriggerBulk.mockRejectedValue(novuErr);

    const res = await attemptTrigger(
      row({
        id: "nx-dlq",
        attempts: 4,
        status: "RETRY",
        firstAttemptAt: new Date(),
      }),
      { relay: true },
    );

    expect(res).toMatchObject({ success: false, outcome: "DEAD_LETTER" });
    const [capturedErr, captureCtx] = mockCaptureException.mock.calls[0];
    expect(capturedErr).toBeInstanceOf(Error);
    expect("body" in capturedErr).toBe(false);
    expect("rawValue" in capturedErr).toBe(false);
    expect(JSON.stringify(mockCaptureException.mock.calls[0])).not.toContain(
      "secret@example.com",
    );
    expect(captureCtx).toMatchObject({
      level: "error",
      tags: expect.objectContaining({
        subsystem: "novu",
        op: "trigger",
        outbox_dead_letter: "true",
      }),
    });
  });
});

describe("notifyPayoutFailed", () => {
  it("keeps distinct failed payouts distinct when amount and reason match", async () => {
    mockUpsert.mockImplementation(async (args) => ({
      id: args.create.transactionId,
      ...args.create,
    }));
    const details = {
      amount: 10000,
      currency: "INR",
      reason: "bank rejected",
      dashboardUrl: "/dashboard/earnings",
    };

    await notifyPayoutFailed(
      "user-a",
      { ...details, payoutId: "payout-one" },
      { deferAttempt: true },
    );
    await notifyPayoutFailed(
      "user-a",
      { ...details, payoutId: "payout-two" },
      { deferAttempt: true },
    );

    const [first, second] = mockUpsert.mock.calls.map(([args]) => args.create);
    expect(first.transactionId).not.toBe(second.transactionId);
    expect(first.payload).toMatchObject({ payoutId: "payout-one" });
    expect(first.entityRef).toBe("payout:payout-one");
    expect(second.entityRef).toBe("payout:payout-two");
    expect(mockTrigger).not.toHaveBeenCalled();
  });
});
