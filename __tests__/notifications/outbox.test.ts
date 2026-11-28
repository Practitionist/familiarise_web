/**
 * @jest-environment node
 */

/**
 * The Novu trigger outbox. Pins: a generation's first attempt freezes the
 * recipients current policy allows; an unknown outcome resends the identical
 * body under the identical key, except that erased users are always dropped;
 * a definitive response ends the generation, so the rest are rechecked and
 * re-keyed; terminal refusals beside retryable ones survive as their own
 * dead-letter row; a single recipient uses the normal trigger and more use
 * the bulk endpoint; a 429 honours Retry-After; rows the earlier sender
 * attempted are held for review; every status write is conditional so
 * nothing overwrites SENT; and the drain takes urgent workflows first.
 */

type WireEvent = { to: string; transactionId: string; payload: unknown };
type SentRequest = {
  endpoint: "trigger" | "bulk";
  events: WireEvent[];
  key: string;
};

const mockTrigger = jest.fn();
const mockTriggerBulk = jest.fn();
const mockRequestLog: SentRequest[] = [];
const mockUpsert = jest.fn();
const mockUpdateMany = jest.fn();
const mockCreateMany = jest.fn();
const mockFindUnique = jest.fn();
const mockUserFindMany = jest.fn();
const mockCaptureException = jest.fn();
const mockPostOpsChat = jest.fn();

jest.mock("../../lib/novu/client", () => ({
  isNovuConfigured: () => true,
  getNovuClient: () => ({
    trigger: (event: WireEvent, key: string) => {
      mockRequestLog.push({ endpoint: "trigger", events: [event], key });
      return mockTrigger(event, key);
    },
    triggerBulk: (body: { events: WireEvent[] }, key: string) => {
      mockRequestLog.push({ endpoint: "bulk", events: body.events, key });
      return mockTriggerBulk(body, key);
    },
  }),
}));

jest.mock("../../lib/prisma", () => {
  const notificationOutbox = {
    upsert: (...args: unknown[]) => mockUpsert(...args),
    updateMany: (...args: unknown[]) => mockUpdateMany(...args),
    createMany: (...args: unknown[]) => mockCreateMany(...args),
    findUnique: (...args: unknown[]) => mockFindUnique(...args),
  };
  return {
    __esModule: true,
    default: {
      notificationOutbox,
      user: {
        findMany: (...args: unknown[]) => mockUserFindMany(...args),
      },
      $transaction: (fn: (tx: unknown) => Promise<unknown>) =>
        fn({ notificationOutbox }),
    },
  };
});

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
  recipientTransactionId,
  stageTrigger,
  terminalTriggerReason,
  triggerIdempotencyKey,
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
  notificationPreferences: { allNotifications: true, inAppEnabled: true },
});
const inAppOff = (id: string) => ({
  ...allowed(id),
  notificationPreferences: { allNotifications: true, inAppEnabled: false },
});
const erased = (id: string) => ({ ...allowed(id), erasedAt: new Date() });

const processed = { acknowledged: true, status: "processed" };
const refusedWith = (status: string, error?: string[]) => ({
  acknowledged: true,
  status,
  ...(error ? { error } : {}),
});

/** Every request the client was asked to send, in call order. */
const requests = () => mockRequestLog;
const request = (index: number) => mockRequestLog[index];
/** Every event sent, across both endpoints, in call order. */
const sentEvents = () => mockRequestLog.flatMap((r) => r.events);

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

/** Rows inserted beside a settle (the terminal split). */
const insertedRows = (): Array<Record<string, unknown>> =>
  mockCreateMany.mock.calls.flatMap(
    ([args]: [{ data: Array<Record<string, unknown>> }]) => args.data,
  );

beforeEach(() => {
  mockUpdateMany.mockResolvedValue({ count: 1 });
  mockCreateMany.mockResolvedValue({ count: 1 });
  mockUserFindMany.mockImplementation(
    async (args: { where: { id: { in: string[] } } }) =>
      args.where.id.in.map(allowed),
  );
  mockTrigger.mockResolvedValue({ headers: {}, result: processed });
  mockTriggerBulk.mockImplementation(async (body: { events: unknown[] }) => ({
    headers: {},
    result: body.events.map(() => processed),
  }));
});
afterEach(() => {
  jest.resetAllMocks();
  mockRequestLog.length = 0;
});

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
    expect(request(0).endpoint).toBe("bulk");
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
    expect(request(0).key).toMatch(
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

  it("sends a single recipient through the normal trigger under its own transactionId", async () => {
    const result = await attemptTrigger(row());

    expect(result).toEqual({ success: true, outcome: "SENT" });
    expect(mockTriggerBulk).not.toHaveBeenCalled();
    const recipientId = recipientTransactionId(row().transactionId, "u1");
    expect(requests()).toEqual([
      {
        endpoint: "trigger",
        events: [
          expect.objectContaining({ to: "u1", transactionId: recipientId }),
        ],
        key: expect.stringMatching(new RegExp(`^${recipientId}:[0-9a-f]{16}$`)),
      },
    ]);
  });

  it("leaves the row PENDING with the cause on a timeout, for the drain to finish", async () => {
    const timeout = new Error("Request timed out");
    timeout.name = "RequestTimeoutError";
    mockTrigger.mockRejectedValue(timeout);

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
    expect(requests()).toHaveLength(0);
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
    expect(requests()).toHaveLength(0);
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

    // Only the erasure check runs on a retry; the soft opt-out is ignored.
    expect(mockUserFindMany).toHaveBeenCalledWith({
      where: { id: { in: ["u1", "u3"] } },
      select: { id: true, erasedAt: true },
    });
    expect(request(1)).toEqual(request(0));
  });

  it("drops a recipient erased after an unknown outcome, even though the body changes", async () => {
    const multi = row({ kind: "MULTI", recipients: ["u1", "u2"] });
    mockTriggerBulk.mockRejectedValueOnce(new Error("socket hang up"));
    await attemptTrigger(multi, { relay: true });
    const frozen = stampCall()!.data as {
      firstAttemptAt: Date;
      recipients: string[];
    };

    mockUserFindMany.mockResolvedValue([allowed("u1"), erased("u2")]);
    await attemptTrigger(
      {
        ...multi,
        status: "RETRY",
        attempts: 1,
        recipients: frozen.recipients,
        firstAttemptAt: frozen.firstAttemptAt,
      },
      { relay: true },
    );

    expect(request(1).events.map((event) => event.to)).toEqual(["u1"]);
    expect(request(1).key).not.toBe(request(0).key);
  });

  it("dead-letters a retry whose every recipient was erased, without calling Novu", async () => {
    mockUserFindMany.mockResolvedValue([erased("u1")]);

    const result = await attemptTrigger(
      row({
        status: "RETRY",
        attempts: 1,
        firstAttemptAt: new Date(Date.now() - 60_000),
      }),
      { relay: true },
    );

    expect(result).toMatchObject({
      outcome: "DEAD_LETTER",
      deadLetterReason: "policy:audience_revoked",
    });
    expect(requests()).toHaveLength(0);
  });

  it("dead-letters as an expected skip when nobody may receive it, and never calls Novu", async () => {
    mockUserFindMany.mockResolvedValue([erased("u1")]);

    const result = await attemptTrigger(row());

    expect(result).toEqual({
      success: true,
      outcome: "DEAD_LETTER",
      deadLetterReason: "policy:audience_revoked",
    });
    expect(requests()).toHaveLength(0);
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
    expect(requests()).toHaveLength(0);
  });

  it("never sends when the policy read fails; the row waits for a later attempt", async () => {
    mockUserFindMany.mockRejectedValue(new Error("db down"));

    const result = await attemptTrigger(row(), { relay: true });

    expect(result).toMatchObject({ success: false, outcome: "PENDING" });
    expect(requests()).toHaveLength(0);
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
    expect(request(1)).toEqual(request(0));
  });
});

describe("definitive responses", () => {
  const anchor = new Date(Date.now() - 60_000);
  const attempted = (overrides: Partial<StagedTrigger> = {}) =>
    row({
      kind: "MULTI",
      status: "RETRY",
      attempts: 1,
      firstAttemptAt: anchor,
      ...overrides,
    });

  it("narrows a partial response to the unaccepted recipients as a fresh generation with a new key", async () => {
    mockTriggerBulk.mockResolvedValueOnce({
      headers: {},
      result: [processed, refusedWith("error")],
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
    expect(narrowing.data).toEqual({
      status: "RETRY",
      attempts: 2,
      nextRetryAt: expect.any(Date),
      recipients: ["u2"],
      firstAttemptAt: null,
      lastError: null,
    });

    mockUpdateMany.mockClear();
    await expect(
      attemptTrigger(
        attempted({ recipients: ["u2"], attempts: 2, firstAttemptAt: null }),
        { relay: true },
      ),
    ).resolves.toEqual({ success: true, outcome: "SENT" });
    // The new generation is rechecked and stamped before its request.
    expect(stampCall()?.data).toEqual({
      firstAttemptAt: expect.any(Date),
      recipients: ["u2"],
    });
    expect(request(1).events.map((event) => event.to)).toEqual(["u2"]);
    expect(request(1).key).not.toBe(request(0).key);
  });

  it("matches bulk results to recipients by transactionId, not position", async () => {
    const eventId = (to: string) =>
      recipientTransactionId(row().transactionId, to);
    mockTriggerBulk.mockResolvedValueOnce({
      headers: {},
      result: [
        { ...refusedWith("error"), transactionId: eventId("u2") },
        { ...processed, transactionId: eventId("u1") },
      ],
    });

    await expect(
      attemptTrigger(attempted({ recipients: ["u1", "u2"] }), { relay: true }),
    ).resolves.toMatchObject({ outcome: "RETRY" });
    expect(updateCalls()[0].data).toMatchObject({ recipients: ["u2"] });
  });

  it("retries a recipient whose result is missing from a shortened response", async () => {
    mockTriggerBulk.mockResolvedValueOnce({
      headers: {},
      result: [
        {
          ...processed,
          transactionId: recipientTransactionId(row().transactionId, "u2"),
        },
      ],
    });

    await expect(
      attemptTrigger(attempted({ recipients: ["u1", "u2"] }), { relay: true }),
    ).resolves.toMatchObject({ outcome: "RETRY" });
    expect(updateCalls()[0].data).toMatchObject({ recipients: ["u1"] });
  });

  it("rechecks policy before the next generation, so a user erased after a refusal is never sent to", async () => {
    mockTriggerBulk.mockResolvedValueOnce({
      headers: {},
      result: [processed, refusedWith("error")],
    });
    await attemptTrigger(attempted({ recipients: ["u1", "u2"] }), {
      relay: true,
    });
    const narrowed = updateCalls()[0].data as { recipients: string[] };

    mockUserFindMany.mockResolvedValue([erased("u2")]);
    const result = await attemptTrigger(
      attempted({
        recipients: narrowed.recipients,
        attempts: 2,
        firstAttemptAt: null,
      }),
      { relay: true },
    );

    expect(result).toMatchObject({
      outcome: "DEAD_LETTER",
      deadLetterReason: "policy:audience_revoked",
    });
    expect(requests()).toHaveLength(1);
  });

  it("starts a fresh generation when nothing was accepted, so a cached refusal is never replayed", async () => {
    mockTrigger.mockResolvedValueOnce({
      headers: {},
      result: refusedWith("error"),
    });

    await attemptTrigger(attempted({ kind: "SINGLE" }), { relay: true });
    expect(settleData()).toMatchObject({
      recipients: ["u1"],
      firstAttemptAt: null,
      status: "RETRY",
    });

    await attemptTrigger(
      attempted({ kind: "SINGLE", attempts: 2, firstAttemptAt: null }),
      { relay: true },
    );
    expect(request(1).events).toEqual(request(0).events);
    expect(request(1).key).not.toBe(request(0).key);
  });

  it("retries an event status the client does not recognise and never marks it SENT", async () => {
    mockTrigger.mockResolvedValueOnce({
      headers: {},
      result: refusedWith("subscriber_id_missing"),
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
    mockTrigger.mockRejectedValueOnce(
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

  it("counts a duplicate transactionId as delivered on the bulk endpoint", async () => {
    mockTriggerBulk.mockResolvedValueOnce({
      headers: {},
      result: [
        refusedWith("error", ["transactionId property is not unique"]),
        processed,
      ],
    });

    await expect(
      attemptTrigger(attempted({ recipients: ["u1", "u2"] }), { relay: true }),
    ).resolves.toEqual({ success: true, outcome: "SENT" });
  });

  it("counts a duplicate transactionId refused by the normal trigger as delivered", async () => {
    mockTrigger.mockRejectedValueOnce(
      Object.assign(new Error("Bad Request"), {
        statusCode: 400,
        body: JSON.stringify({
          statusCode: 400,
          message: "transactionId property is not unique",
        }),
      }),
    );

    await expect(
      attemptTrigger(attempted({ kind: "SINGLE" }), { relay: true }),
    ).resolves.toEqual({ success: true, outcome: "SENT" });
  });

  it("keeps terminally refused recipients as a dead-letter row while the rest retry and succeed", async () => {
    mockTriggerBulk.mockResolvedValueOnce({
      headers: {},
      result: [
        processed,
        refusedWith("invalid_recipients"),
        refusedWith("error"),
      ],
    });

    const result = await attemptTrigger(
      attempted({
        recipients: ["u1", "u2", "u3"],
        entityRef: "appointment:appt-1",
      }),
      { relay: true },
    );

    expect(result).toMatchObject({
      outcome: "RETRY",
      terminalSplit: expect.stringContaining("novu_invalid_recipients"),
    });
    expect(settleData()).toMatchObject({
      status: "RETRY",
      recipients: ["u3"],
      firstAttemptAt: null,
    });
    expect(insertedRows()).toEqual([
      expect.objectContaining({
        workflowId: "appointment-booked",
        kind: "SINGLE",
        recipients: ["u2"],
        payload,
        status: "DEAD_LETTER",
        entityRef: "appointment:appt-1",
        firstAttemptAt: anchor,
        transactionId: expect.stringMatching(
          new RegExp(`^${row().transactionId}:terminal:[0-9a-f]{16}$`),
        ),
        lastError: expect.stringContaining("novu_invalid_recipients"),
      }),
    ]);

    await expect(
      attemptTrigger(
        attempted({ recipients: ["u3"], attempts: 2, firstAttemptAt: null }),
        { relay: true },
      ),
    ).resolves.toEqual({ success: true, outcome: "SENT" });
    // The parent settles SENT; the dropped recipient stays recorded on its own row.
    expect(mockUpdateMany).toHaveBeenLastCalledWith({
      where: { id: "nx-1", status: ACTIVE },
      data: expect.objectContaining({ status: "SENT" }),
    });
    expect(insertedRows()).toHaveLength(1);
  });

  it("inserts no split row when the narrowing lost to a newer generation", async () => {
    mockUpdateMany.mockResolvedValue({ count: 0 });
    mockTriggerBulk.mockResolvedValueOnce({
      headers: {},
      result: [refusedWith("invalid_recipients"), refusedWith("error")],
    });

    const result = await attemptTrigger(
      attempted({ recipients: ["u1", "u2"] }),
      { relay: true },
    );

    expect(result).not.toHaveProperty("terminalSplit");
    expect(mockCreateMany).not.toHaveBeenCalled();
  });

  it("dead-letters and pages only when nothing is left to send and something was refused terminally", async () => {
    mockTrigger.mockResolvedValue({
      headers: {},
      result: refusedWith("trigger_not_active"),
    });

    const result = await attemptTrigger(row(), { relay: true });

    expect(result).toMatchObject({ success: false, outcome: "DEAD_LETTER" });
    expect(settleData()).toMatchObject({
      status: "DEAD_LETTER",
      recipients: ["u1"],
    });
    expect(mockCreateMany).not.toHaveBeenCalled();
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
    expect(request(0).events).toHaveLength(100);
    const progress = updateCalls()[0];
    expect(progress.where).toEqual({
      id: "nx-1",
      status: ACTIVE,
      firstAttemptAt: anchor,
    });
    expect(progress.data).toEqual({
      recipients: recipients.slice(100),
      firstAttemptAt: null,
      lastError: null,
      nextRetryAt: expect.any(Date),
    });
  });
});

describe("rows with no first-attempt anchor", () => {
  it("sends a row whose error came before any anchor, since no request carried it", async () => {
    await expect(
      attemptTrigger(row({ attempts: 1, lastError: "Request timed out" }), {
        relay: true,
      }),
    ).resolves.toEqual({ success: true, outcome: "SENT" });
  });

  it("sends a row nobody attempted yet", async () => {
    await expect(
      attemptTrigger(row({ attempts: 0, lastError: null }), { relay: true }),
    ).resolves.toEqual({ success: true, outcome: "SENT" });
  });
});

describe("triggerIdempotencyKey", () => {
  const wire = { workflowId: "appointments", payload: { a: 1, b: "x" } };
  const at = new Date("2026-11-01T00:00:00Z");
  const key = triggerIdempotencyKey("wf:abc", at, ["u1", "u2"], wire);

  it("is stable for the same anchor, recipients and canonical payload", () => {
    expect(
      triggerIdempotencyKey("wf:abc", at, ["u1", "u2"], {
        workflowId: "appointments",
        payload: { b: "x", a: 1 },
      }),
    ).toBe(key);
  });

  it("changes when the payload, the recipients or the anchor change", () => {
    expect(
      triggerIdempotencyKey("wf:abc", at, ["u1", "u2"], {
        ...wire,
        payload: { ...wire.payload, href: "/new" },
      }),
    ).not.toBe(key);
    expect(triggerIdempotencyKey("wf:abc", at, ["u2", "u3"], wire)).not.toBe(
      key,
    );
    expect(
      triggerIdempotencyKey(
        "wf:abc",
        new Date(at.getTime() + 1),
        ["u1", "u2"],
        wire,
      ),
    ).not.toBe(key);
  });

  it("prefixes a single recipient's key with that recipient's transactionId", () => {
    expect(triggerIdempotencyKey("wf:abc", at, ["u1"], wire)).toMatch(
      new RegExp(`^${recipientTransactionId("wf:abc", "u1")}:[0-9a-f]{16}$`),
    );
  });
});

describe("conditional writes, rate limits and the replay window", () => {
  it("retries a Novu 409 (same key still in flight) with the recipients unchanged", async () => {
    expect(terminalTriggerReason(409, "in progress")).toBeNull();
    mockTrigger.mockRejectedValue(
      Object.assign(new Error("Conflict"), { statusCode: 409, body: "" }),
    );

    const result = await attemptTrigger(row(), { relay: true });

    expect(result).toMatchObject({ success: false, outcome: "RETRY" });
    expect(settleData()).toMatchObject({ status: "RETRY", attempts: 1 });
    expect(settleData()).not.toHaveProperty("recipients");
  });

  it("waits out a 429's Retry-After when it is longer than the backoff", async () => {
    const now = Date.now();
    mockTrigger.mockRejectedValue(
      Object.assign(new Error("Too Many Requests"), {
        statusCode: 429,
        body: "",
        headers: new Headers({ "retry-after": "1800" }),
      }),
    );

    const result = await attemptTrigger(row(), { relay: true, now: () => now });

    expect(result).toMatchObject({ outcome: "RETRY", retryAfterMs: 1_800_000 });
    expect(settleData()).toMatchObject({
      status: "RETRY",
      nextRetryAt: new Date(now + 1_800_000),
    });
  });

  it("falls back to the backoff when a 429 carries no usable header", async () => {
    const now = Date.now();
    mockTrigger.mockRejectedValue(
      Object.assign(new Error("Too Many Requests"), {
        statusCode: 429,
        body: "",
        headers: new Headers(),
      }),
    );

    const result = await attemptTrigger(row(), { relay: true, now: () => now });

    expect(result).not.toHaveProperty("retryAfterMs");
    expect(settleData()).toMatchObject({
      nextRetryAt: new Date(now + 5 * 60_000),
    });
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
    expect(requests()).toHaveLength(0);
    expect(mockUpdateMany).toHaveBeenCalledTimes(1);
  });

  it("guards every settle on an active status, so a late failure cannot overwrite SENT", async () => {
    mockTrigger.mockRejectedValue(
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
    expect(requests()).toHaveLength(1);
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
    expect(requests()).toHaveLength(0);
  });
});

describe("auth rejections and workflow_not_found", () => {
  const keyRejected = (statusCode: number) =>
    Object.assign(new Error("Unauthorized"), {
      statusCode,
      body: '{"message":"API Key not found"}',
    });

  it.each([
    [401, "API Key not found", null],
    [403, "Forbidden", null],
    [422, "workflow_not_found", "workflow_not_found"],
    [404, "Subscriber not found", "http_404"],
    [400, "Bad Request", "http_400"],
  ])("classifies %i %s as %s", (status, message, reason) => {
    expect(terminalTriggerReason(status, message)).toBe(reason);
  });

  it("retries a relay 401 on the backoff instead of dead-lettering it", async () => {
    const now = Date.now();
    mockTrigger.mockRejectedValue(keyRejected(401));

    const result = await attemptTrigger(row(), { relay: true, now: () => now });

    expect(result).toMatchObject({ success: false, outcome: "RETRY" });
    expect(settleData()).toMatchObject({
      status: "RETRY",
      attempts: 1,
      nextRetryAt: new Date(now + 5 * 60_000),
    });
  });

  it("dead-letters a relay 401 once as exhausted at the attempt cap", async () => {
    mockTrigger.mockRejectedValue(keyRejected(401));

    const result = await attemptTrigger(
      row({ status: "RETRY", attempts: 4, firstAttemptAt: new Date() }),
      { relay: true },
    );

    expect(result).toMatchObject({ success: false, outcome: "DEAD_LETTER" });
    expect(settleData()).toMatchObject({ status: "DEAD_LETTER", attempts: 5 });
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
    expect(mockCaptureException.mock.calls[0][1]).toMatchObject({
      level: "error",
      fingerprint: ["novu-trigger-exhausted", "appointment-booked"],
    });
  });

  it("leaves an inline 401 PENDING without a Sentry capture", async () => {
    mockTrigger.mockRejectedValue(keyRejected(401));

    const result = await attemptTrigger(row());

    expect(result).toMatchObject({ success: false, outcome: "PENDING" });
    expect(settleData()).not.toHaveProperty("status");
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it("drops only a bulk event refused as workflow_not_found, and retries one whose subscriber is missing", async () => {
    mockTriggerBulk.mockResolvedValueOnce({
      headers: {},
      result: [
        refusedWith("error", ["workflow_not_found"]),
        refusedWith("error", ["Subscriber not found"]),
      ],
    });

    const result = await attemptTrigger(
      row({
        kind: "MULTI",
        status: "RETRY",
        attempts: 1,
        recipients: ["u1", "u2"],
        firstAttemptAt: new Date(Date.now() - 60_000),
      }),
      { relay: true },
    );

    expect(result).toMatchObject({
      outcome: "RETRY",
      terminalSplit: expect.stringContaining("workflow_not_found"),
    });
    expect(settleData()).toMatchObject({ status: "RETRY", recipients: ["u2"] });
    expect(insertedRows()).toEqual([
      expect.objectContaining({ recipients: ["u1"], status: "DEAD_LETTER" }),
    ]);
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

  it("counts and alerts on a terminal split even though its parent only retries", async () => {
    const findMany = jest
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([row()]);
    const attempt = jest.fn().mockResolvedValue({
      success: false,
      outcome: "RETRY",
      terminalSplit: "Novu refused 1 recipient(s) terminally (novu_x)",
    });

    const result = await runNotificationDrainTick({
      prisma: { notificationOutbox: { findMany } },
      now: () => now.getTime(),
      attempt,
    });

    expect(result).toMatchObject({ retried: 1, deadLettered: 1 });
    expect(mockPostOpsChat).toHaveBeenCalledTimes(1);
  });

  it("starts no further wave after Novu answers 429, but records the whole wave", async () => {
    const rows = Array.from({ length: 12 }, (_, i) => row({ id: `r${i}` }));
    const findMany = jest
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(rows);
    const attempt = jest.fn(async (r: StagedTrigger) =>
      r.id === "r2"
        ? { success: false, outcome: "RETRY" as const, retryAfterMs: 30_000 }
        : { success: true, outcome: "SENT" as const },
    );

    const result = await runNotificationDrainTick({
      prisma: { notificationOutbox: { findMany } },
      now: () => now.getTime(),
      attempt,
    });

    // The probe row, then one wave of five; r2's 429 stops the rest.
    expect(attempt).toHaveBeenCalledTimes(6);
    expect(result).toMatchObject({ scanned: 6, sent: 5, retried: 1 });
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
    mockTrigger.mockRejectedValue(novuErr);

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
    expect(requests()).toHaveLength(0);
  });
});
