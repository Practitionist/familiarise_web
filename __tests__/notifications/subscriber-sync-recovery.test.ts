/** @jest-environment node */
const mockSyncDrain = jest.fn();
const mockOutboxRead = jest.fn();
const mockCapture = jest.fn();
jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: {
    notificationOutbox: {
      findMany: (...args: unknown[]) => mockOutboxRead(...args),
    },
  },
}));
jest.mock("@/lib/novu/subscriber", () => ({
  ...jest.requireActual<typeof import("@/lib/novu/subscriber")>(
    "@/lib/novu/subscriber",
  ),
  drainSubscriberSyncs: (...args: unknown[]) => mockSyncDrain(...args),
}));
jest.mock("@/lib/cron/with-cron-lock", () => ({
  withCronLock: async (
    _job: string,
    _options: unknown,
    run: () => Promise<unknown>,
  ) => run(),
  CronLockHeldError: class extends Error {},
}));
jest.mock("@sentry/nextjs", () => ({
  captureException: (...args: unknown[]) => mockCapture(...args),
}));

import {
  drainNotificationOutbox,
  hasNotificationOutboxWork,
} from "@/jobs/notifications/drain-notification-outbox";

beforeEach(() => {
  jest.clearAllMocks();
  mockOutboxRead.mockResolvedValue([]);
});

describe("subscriber synchronization on the existing relay", () => {
  it("shares the requested budget and reports a single aggregated failure", async () => {
    const sync = { scanned: 3, synced: 1, pending: 0, failures: 2 };
    mockSyncDrain.mockResolvedValue(sync);
    const result = await drainNotificationOutbox({ limit: 8 });
    expect(mockSyncDrain).toHaveBeenCalledWith(expect.anything(), 4);
    expect(mockOutboxRead).toHaveBeenCalledWith(
      expect.objectContaining({ take: 5 }),
    );
    expect(result.subscriberSync).toEqual(sync);
    expect(result.errors).toEqual([
      "2 failed and 0 pending subscriber synchronization(s)",
    ]);
    expect(mockCapture).toHaveBeenCalledTimes(1);
  });

  it("does not report a clean job while pending recipients lack provider configuration", async () => {
    mockSyncDrain.mockResolvedValue({
      scanned: 2,
      synced: 0,
      pending: 2,
      failures: 0,
    });
    const result = await drainNotificationOutbox({ limit: 4 });
    expect(result.errors).toEqual([
      "0 failed and 2 pending subscriber synchronization(s)",
    ]);
    expect(mockCapture).toHaveBeenCalledTimes(1);
  });

  it("wakes an otherwise empty relay when a preference obligation is pending", async () => {
    const db = {
      notificationOutbox: { findFirst: jest.fn().mockResolvedValue(null) },
      notificationPreference: {
        findFirst: jest.fn().mockResolvedValue({ userId: "recipient" }),
      },
    };
    await expect(
      hasNotificationOutboxWork(db, new Date(), () => false),
    ).resolves.toBe(true);
    expect(db.notificationPreference.findFirst).toHaveBeenCalledWith({
      where: {
        novuSyncPendingAt: { not: null },
        user: { emailVerified: true, erasedAt: null },
      },
      select: { userId: true },
    });
  });

  it("leaves an exhausted ticker probe budget fail-open without extra queries", async () => {
    const db = {
      notificationOutbox: { findFirst: jest.fn().mockResolvedValue(null) },
      notificationPreference: { findFirst: jest.fn() },
    };
    let checks = 0;
    await expect(
      hasNotificationOutboxWork(db, new Date(), () => ++checks > 1),
    ).resolves.toBe(true);
    expect(db.notificationPreference.findFirst).not.toHaveBeenCalled();
  });
});
