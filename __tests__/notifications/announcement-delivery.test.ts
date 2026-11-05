/** @jest-environment node */
const mockFind = jest.fn();
const mockUpdate = jest.fn();
const mockBroadcast = jest.fn();
const mockCapture = jest.fn();
const mockChat = jest.fn();
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    announcement: { findUnique: (...args: unknown[]) => mockFind(...args) },
    notificationOutbox: { update: (...args: unknown[]) => mockUpdate(...args) },
  },
}));
jest.mock("../../lib/novu/client", () => ({
  isNovuConfigured: () => true,
  getNovuClient: () => ({
    triggerBroadcast: (...args: unknown[]) => mockBroadcast(...args),
  }),
}));
jest.mock("@sentry/nextjs", () => ({
  captureException: (...args: unknown[]) => mockCapture(...args),
  captureMessage: jest.fn(),
}));
jest.mock("@sentry/core", () => jest.requireMock("@sentry/nextjs"));
jest.mock("../../lib/observability/ops-chat", () => ({
  postOpsChat: (...args: unknown[]) => mockChat(...args),
}));
import { attemptTrigger, type StagedTrigger } from "@/lib/novu/outbox";
import { runNotificationDrainTick } from "@/jobs/notifications/drain-notification-outbox";

const now = new Date("2026-11-05T00:00:00Z");
const current = {
  title: "News",
  content: "Details",
  linkUrl: null,
  linkText: null,
  isActive: true,
  startDate: null,
  endDate: null,
  updatedAt: now,
};
const row: StagedTrigger = {
  id: "row",
  workflowId: "general-announcement",
  kind: "BROADCAST",
  recipients: [],
  payload: {
    announcementId: "one",
    revision: now.toISOString(),
    startDate: null,
    endDate: null,
    title: "News",
    content: "Details",
  },
  transactionId: "stable",
  attempts: 0,
  status: "PENDING",
  notBefore: null,
};
beforeEach(() => {
  jest.clearAllMocks();
  mockFind.mockResolvedValue(current);
  mockBroadcast.mockResolvedValue({});
});

it.each([
  null,
  { ...current, isActive: false },
  { ...current, endDate: now },
  { ...current, updatedAt: new Date(now.getTime() + 1) },
])(
  "does not publish deleted, disabled, expired or superseded announcements",
  async (source) => {
    mockFind.mockResolvedValue(source);
    expect(
      await attemptTrigger(row, { relay: true, now: () => now.getTime() }),
    ).toMatchObject({ success: true, outcome: "DEAD_LETTER" });
    expect(mockBroadcast).not.toHaveBeenCalled();
    expect(mockCapture).not.toHaveBeenCalled();
  },
);
it("honours notBefore even for a direct relay attempt", async () => {
  const notBefore = new Date(now.getTime() + 60000);
  expect(
    (
      await attemptTrigger(
        { ...row, notBefore },
        { relay: true, now: () => now.getTime() },
      )
    ).outcome,
  ).toBe("PENDING");
  expect(mockBroadcast).not.toHaveBeenCalled();
  expect(mockFind).not.toHaveBeenCalled();
});
it("restores the delivery floor if a due row references a future source", async () => {
  const startDate = new Date(now.getTime() + 60000);
  mockFind.mockResolvedValue({ ...current, startDate });
  expect(
    (
      await attemptTrigger(
        {
          ...row,
          payload: {
            announcementId: "one",
            revision: now.toISOString(),
            title: "News",
            content: "Details",
            startDate: startDate.toISOString(),
            endDate: null,
          },
        },
        { relay: true, now: () => now.getTime() },
      )
    ).outcome,
  ).toBe("PENDING");
  expect(mockUpdate).toHaveBeenCalledWith(
    expect.objectContaining({
      data: { notBefore: startDate, nextRetryAt: startDate },
    }),
  );
  expect(mockBroadcast).not.toHaveBeenCalled();
});
it("retains pending work if the source cannot be read", async () => {
  mockFind.mockRejectedValueOnce(new Error("pool unavailable"));
  expect(
    await attemptTrigger(row, { relay: true, now: () => now.getTime() }),
  ).toMatchObject({ success: false, outcome: "PENDING" });
  expect(mockUpdate).not.toHaveBeenCalled();
  expect(mockBroadcast).not.toHaveBeenCalled();
});
it("sends the due current revision with its stable provider identity", async () => {
  expect(
    (await attemptTrigger(row, { relay: true, now: () => now.getTime() }))
      .outcome,
  ).toBe("SENT");
  expect(mockBroadcast).toHaveBeenCalledWith(
    expect.objectContaining({ transactionId: "stable" }),
    "stable",
  );
});
it("never attempts an already cancelled terminal row", async () => {
  expect(
    (await attemptTrigger({ ...row, status: "DEAD_LETTER" })).outcome,
  ).toBe("DEAD_LETTER");
  expect(mockBroadcast).not.toHaveBeenCalled();
  expect(mockFind).not.toHaveBeenCalled();
});
it("counts an expected cancellation without a bug or ops-chat alert", async () => {
  const result = await runNotificationDrainTick({
    prisma: { notificationOutbox: { findMany: async () => [row] } },
    now: () => now.getTime(),
    attempt: async () => ({ success: true, outcome: "DEAD_LETTER" }),
  });
  expect(result.deadLettered).toBe(1);
  expect(mockCapture).not.toHaveBeenCalled();
  expect(mockChat).not.toHaveBeenCalled();
});

it("does not turn a retry into an error-level page just because another row was cancelled", async () => {
  const result = await runNotificationDrainTick({
    prisma: {
      notificationOutbox: {
        findMany: async () => [row, { ...row, id: "retry" }],
      },
    },
    now: () => now.getTime(),
    attempt: async (item) =>
      item.id === "row"
        ? { success: true, outcome: "DEAD_LETTER" }
        : { success: false, outcome: "RETRY", error: "provider unavailable" },
  });
  expect(result.deadLettered).toBe(1);
  expect(result.retried).toBe(1);
  expect(mockCapture).toHaveBeenCalledWith(
    expect.any(Error),
    expect.objectContaining({ level: "warning" }),
  );
  expect(mockChat).not.toHaveBeenCalled();
});

it("rejects stale content even when two edits share a millisecond timestamp", async () => {
  mockFind.mockResolvedValue({
    ...current,
    content: "Revised without a clock tick",
  });
  expect(
    (await attemptTrigger(row, { relay: true, now: () => now.getTime() }))
      .outcome,
  ).toBe("DEAD_LETTER");
  expect(mockBroadcast).not.toHaveBeenCalled();
});

it("keeps malformed publication context actionable instead of hiding it as a cancellation", async () => {
  const result = await runNotificationDrainTick({
    prisma: {
      notificationOutbox: { findMany: async () => [{ ...row, payload: {} }] },
    },
    now: () => now.getTime(),
  });
  expect(result.deadLettered).toBe(1);
  expect(mockCapture).toHaveBeenCalledWith(
    expect.any(Error),
    expect.objectContaining({ level: "error" }),
  );
  expect(mockChat).toHaveBeenCalledTimes(1);
  expect(mockBroadcast).not.toHaveBeenCalled();
});
