/**
 * @jest-environment node
 */

/**
 * The Novu trigger outbox. Pins: the first attempt freezes the recipients
 * current policy allows; an unknown outcome resends the identical body under
 * the identical key; only a definitive response narrows the recipients (and
 * so changes the key); the row is SENT only when Novu accepted every event;
 * revoked audiences, the replay window and Novu 409 settle the way the relay
 * expects; every status write is conditional so nothing overwrites SENT; and
 * the drain takes urgent workflows first.
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
  bulkIdempotencyKey,
  deriveTransactionId,
  outboxTransactionIdOf,
  recipientTransactionId,
  stageTrigger,
  terminalTriggerReason,
  type StagedTrigger,
} from "@/lib/novu/outbox";
import { PROVIDER_REPLAY_WINDOW_MS } from "@/lib/retry/provider-window";
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

type UpdateManyArgs = {
  where: Record<string, unknown>;
  data: Record<string, unknown>;
};

const updateCalls = (): UpdateManyArgs[] =>
  mockUpdateMany.mock.calls.map(([args]: [UpdateManyArgs]) => args);

/** The conditional update that stamps `firstAttemptAt` on the first attempt. */
const stampCall = () =>
  updateCalls().find((args) => args.where.firstAttemptAt === null);

/** The `data` of the updateMany that settled the row (not the stamp). */
function settleData(): Record<string, unknown> | undefined {
  return updateCalls().find((args) => args.where.firstAttemptAt !== null)?.data;
}

type BulkCall = [
  { events: Array<{ to: string; transactionId: string; payload: unknown }> },
  string,
];
const bulkCall = (index: number) =>
  mockTriggerBulk.mock.calls[index] as BulkCall;

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
afterEach(() => jest.resetAllMocks());

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
    expect(bulkCall(0)[1]).toMatch(
      new RegExp(`^${transactionId}:bulk:[0-9a-f]{16}$`),
    );
    // The first attempt freezes the allowed set with the stamp, only while active.
    expect(mockUpdateMany.mock.calls[0][0]).toEqual({
      where: { id: "nx-1", status: ACTIVE, firstAttemptAt: null },
      data: { firstAttemptAt: expect.any(Date), recipients: ["u2", "u1"] },
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

  it("reports a failed stage outside a transaction and sends nothing", async () => {
    mockUpsert.mockRejectedValue(new Error("db down"));

    const result = await notifyPayoutFailed("user-a", {
      amount: 10000,
      currency: "INR",
      reason: "bank rejected",
      dashboardUrl: "/dashboard/earnings",
      payoutId: "payout-one",
    });

    expect(result).toEqual({
      success: false,
      error: "Stage failed; notice not sent",
    });
    expect(mockTriggerBulk).not.toHaveBeenCalled();
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
  });
});

describe("first attempt freezes the audience", () => {
  it("persists only the recipients current policy allows, in the same update as the stamp", async () => {
    const multi = row({ kind: "MULTI", recipients: ["u1", "u2", "u3"] });
    mockUserFindMany.mockResolvedValue([
      allowed("u1"),
      inAppOff("u2"),
      allowed("u3"),
    ]);

    await attemptTrigger(multi, { relay: true });

    expect(stampCall()).toEqual({
      where: { id: multi.id, status: ACTIVE, firstAttemptAt: null },
      data: { firstAttemptAt: expect.any(Date), recipients: ["u1", "u3"] },
    });
    expect(sentEvents().map((event) => event.to)).toEqual(["u1", "u3"]);
  });

  it("resends the identical body under the identical key after an unknown outcome, even if a recipient opted out since", async () => {
    const multi = row({ kind: "MULTI", recipients: ["u1", "u3"] });
    mockTriggerBulk.mockRejectedValueOnce(new Error("socket hang up"));

    await attemptTrigger(multi, { relay: true });
    const frozen = stampCall()!.data as {
      firstAttemptAt: Date;
      recipients: string[];
    };
    expect(settleData()).toEqual({
      status: "RETRY",
      attempts: 1,
      nextRetryAt: expect.any(Date),
      lastError: "socket hang up",
    });

    mockUserFindMany.mockClear();
    mockUserFindMany.mockResolvedValue([allowed("u1"), inAppOff("u3")]);
    await expect(
      attemptTrigger(
        {
          ...multi,
          status: "RETRY",
          attempts: 1,
          recipients: frozen.recipients,
          firstAttemptAt: frozen.firstAttemptAt,
        },
        { relay: true },
      ),
    ).resolves.toEqual({ success: true, outcome: "SENT" });

    expect(mockUserFindMany).not.toHaveBeenCalled();
    expect(bulkCall(1)).toEqual(bulkCall(0));
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

  it("sends exactly the set another attempt froze when it lost the stamp", async () => {
    const anchor = new Date(Date.now() - 1000);
    mockUpdateMany.mockResolvedValueOnce({ count: 0 });
    mockFindUnique.mockResolvedValue({
      status: "PENDING",
      firstAttemptAt: anchor,
      recipients: ["u1"],
    });

    await attemptTrigger(row({ kind: "MULTI", recipients: ["u1", "u2"] }), {
      relay: true,
    });

    expect(sentEvents().map((event) => event.to)).toEqual(["u1"]);
    // Same body and key as the winner's own attempt on that frozen set.
    await attemptTrigger(
      row({ kind: "MULTI", recipients: ["u1"], firstAttemptAt: anchor }),
      { relay: true },
    );
    expect(bulkCall(1)).toEqual(bulkCall(0));
  });
});

describe("definitive bulk responses", () => {
  const anchor = new Date(Date.now() - 60_000);
  const attempted = (overrides: Partial<StagedTrigger> = {}) =>
    row({
      kind: "MULTI",
      status: "RETRY",
      attempts: 1,
      firstAttemptAt: anchor,
      ...overrides,
    });

  it("narrows a partial response to the unaccepted recipients, and the next attempt uses a new key for them only", async () => {
    mockTriggerBulk.mockResolvedValueOnce({
      headers: {},
      result: [processed, { acknowledged: true, status: "error" }],
    });

    await expect(
      attemptTrigger(attempted({ recipients: ["u1", "u2"] }), { relay: true }),
    ).resolves.toMatchObject({ outcome: "RETRY" });

    const narrowing = updateCalls()[0];
    expect(narrowing.where).toEqual({
      id: "nx-1",
      status: ACTIVE,
      firstAttemptAt: anchor,
    });
    expect(narrowing.data).toMatchObject({
      status: "RETRY",
      attempts: 2,
      recipients: ["u2"],
    });
    const nextAnchor = narrowing.data.firstAttemptAt as Date;
    expect(nextAnchor.getTime()).toBeGreaterThan(anchor.getTime());

    await expect(
      attemptTrigger(
        attempted({
          recipients: ["u2"],
          attempts: 2,
          firstAttemptAt: nextAnchor,
        }),
        { relay: true },
      ),
    ).resolves.toEqual({ success: true, outcome: "SENT" });
    expect(bulkCall(1)[0].events.map((event) => event.to)).toEqual(["u2"]);
    expect(bulkCall(1)[1]).not.toBe(bulkCall(0)[1]);
  });

  it("moves the anchor when nothing was accepted, so a cached refusal is never replayed", async () => {
    mockTriggerBulk.mockResolvedValueOnce({
      headers: {},
      result: [{ acknowledged: true, status: "error" }],
    });

    await attemptTrigger(attempted({ kind: "SINGLE" }), { relay: true });
    const narrowed = settleData()!;
    expect(narrowed).toMatchObject({ recipients: ["u1"], status: "RETRY" });

    await attemptTrigger(
      attempted({
        kind: "SINGLE",
        attempts: 2,
        firstAttemptAt: narrowed.firstAttemptAt as Date,
      }),
      { relay: true },
    );
    expect(bulkCall(1)[0]).toEqual(bulkCall(0)[0]);
    expect(bulkCall(1)[1]).not.toBe(bulkCall(0)[1]);
  });

  it("retries an event status the client does not recognise and never marks it SENT", async () => {
    mockTriggerBulk.mockResolvedValueOnce({
      headers: {},
      result: [{ acknowledged: true, status: "subscriber_id_missing" }],
    });

    const result = await attemptTrigger(attempted({ kind: "SINGLE" }), {
      relay: true,
    });

    expect(result).toMatchObject({ success: false, outcome: "RETRY" });
    expect(settleData()).toMatchObject({ status: "RETRY" });
  });

  it("reads the event results of a 2xx the SDK failed to validate, instead of marking the row SENT", async () => {
    mockTriggerBulk.mockRejectedValueOnce(
      Object.assign(new Error("Response validation failed"), {
        statusCode: 201,
        body: JSON.stringify([
          { acknowledged: true, status: "processed" },
          { acknowledged: true, status: "subscriber_id_missing" },
        ]),
      }),
    );

    const result = await attemptTrigger(
      attempted({ recipients: ["u1", "u2"] }),
      { relay: true },
    );

    expect(result).toMatchObject({ outcome: "RETRY" });
    expect(settleData()).toMatchObject({ recipients: ["u2"] });
  });

  it("treats an unreadable 2xx as an unknown outcome: retry with the recipients unchanged", async () => {
    mockTriggerBulk.mockRejectedValueOnce(
      Object.assign(new Error("Response validation failed"), {
        statusCode: 201,
        body: "<html>",
      }),
    );

    const result = await attemptTrigger(attempted(), { relay: true });

    expect(result).toMatchObject({ outcome: "RETRY" });
    expect(settleData()).not.toHaveProperty("recipients");
    expect(updateCalls()[0].where).toEqual({ id: "nx-1", status: ACTIVE });
  });

  it("counts a duplicate transactionId as delivered", async () => {
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
      attemptTrigger(attempted({ recipients: ["u1", "u2"] }), { relay: true }),
    ).resolves.toEqual({ success: true, outcome: "SENT" });
  });

  it("drops terminally refused recipients and keeps retrying the rest", async () => {
    mockTriggerBulk.mockResolvedValueOnce({
      headers: {},
      result: [
        processed,
        { acknowledged: true, status: "invalid_recipients" },
        { acknowledged: true, status: "error" },
      ],
    });

    const result = await attemptTrigger(
      attempted({ recipients: ["u1", "u2", "u3"] }),
      { relay: true },
    );

    expect(result).toMatchObject({ outcome: "RETRY" });
    expect(settleData()).toMatchObject({
      status: "RETRY",
      recipients: ["u3"],
      lastError: expect.stringContaining("dropped 1 (novu_invalid_recipients)"),
    });
  });

  it("dead-letters and pages only when nothing is left to send and something was refused terminally", async () => {
    mockTriggerBulk.mockResolvedValue({
      headers: {},
      result: [{ acknowledged: true, status: "trigger_not_active" }],
    });

    const result = await attemptTrigger(row(), { relay: true });

    expect(result).toMatchObject({ success: false, outcome: "DEAD_LETTER" });
    expect(settleData()).toMatchObject({
      status: "DEAD_LETTER",
      recipients: ["u1"],
    });
    expect(mockCaptureException.mock.calls[0][1]).toMatchObject({
      level: "error",
      fingerprint: ["novu-trigger-terminal", "novu_trigger_not_active"],
    });
  });

  it("sends a row over the bulk limit 100 at a time without spending a retry", async () => {
    const recipients = Array.from({ length: 150 }, (_, i) => `u${i}`);

    const result = await attemptTrigger(attempted({ recipients }), {
      relay: true,
    });

    expect(result).toEqual({ success: true, outcome: "PENDING" });
    expect(mockTriggerBulk).toHaveBeenCalledTimes(1);
    expect(bulkCall(0)[0].events).toHaveLength(100);
    const progress = updateCalls()[0];
    expect(progress.where).toEqual({
      id: "nx-1",
      status: ACTIVE,
      firstAttemptAt: anchor,
    });
    expect(progress.data).toEqual({
      recipients: recipients.slice(100),
      firstAttemptAt: expect.any(Date),
      nextRetryAt: expect.any(Date),
    });
  });
});

describe("bulkIdempotencyKey", () => {
  const wire = { workflowId: "appointments", payload: { a: 1, b: "x" } };
  const at = new Date("2026-11-01T00:00:00Z");
  const key = bulkIdempotencyKey("wf:abc", at, ["u1", "u2"], wire);

  it("is stable for the same anchor, recipients and canonical payload", () => {
    expect(
      bulkIdempotencyKey("wf:abc", at, ["u1", "u2"], {
        workflowId: "appointments",
        payload: { b: "x", a: 1 },
      }),
    ).toBe(key);
  });

  it("changes when the payload, the recipients or the anchor change", () => {
    expect(
      bulkIdempotencyKey("wf:abc", at, ["u1", "u2"], {
        ...wire,
        payload: { ...wire.payload, href: "/new" },
      }),
    ).not.toBe(key);
    expect(bulkIdempotencyKey("wf:abc", at, ["u2"], wire)).not.toBe(key);
    expect(
      bulkIdempotencyKey(
        "wf:abc",
        new Date(at.getTime() + 1),
        ["u1", "u2"],
        wire,
      ),
    ).not.toBe(key);
  });
});

describe("conditional writes and the replay window", () => {
  it("retries a Novu 409 (same key still in flight) with the recipients unchanged", async () => {
    expect(terminalTriggerReason(409, "in progress")).toBeNull();
    mockTriggerBulk.mockRejectedValue(
      Object.assign(new Error("Conflict"), { statusCode: 409, body: "" }),
    );

    const result = await attemptTrigger(row(), { relay: true });

    expect(result).toMatchObject({ success: false, outcome: "RETRY" });
    expect(settleData()).toMatchObject({ status: "RETRY", attempts: 1 });
    expect(settleData()).not.toHaveProperty("recipients");
  });

  it("does not send when a concurrent attempt already settled the row SENT", async () => {
    mockUpdateMany.mockResolvedValueOnce({ count: 0 });
    mockFindUnique.mockResolvedValue({
      status: "SENT",
      firstAttemptAt: null,
      recipients: ["u1"],
    });

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
    expect(mockTriggerBulk).not.toHaveBeenCalled();
  });
});
