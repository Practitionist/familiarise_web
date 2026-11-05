/** @jest-environment node */
import type { StagedTrigger } from "@/lib/novu/outbox";

type Recipient = {
  id: string;
  timezone?: string;
  notificationPreferences?: {
    inAppEnabled?: boolean;
    quietHoursEnabled?: boolean;
    quietHoursStart?: string;
    quietHoursEnd?: string;
    quietHoursTimezone?: string;
  };
};
const mockRows = new Map<string, StagedTrigger>();
let mockUsers: Recipient[] = [];
let mockInTransaction = false;
let mockConfigured = true;
const mockTxRead = jest.fn(async (..._args: unknown[]) => mockUsers);
const mockGlobalRead = jest.fn(async (..._args: unknown[]) => {
  if (mockInTransaction) throw new Error("Global query inside transaction");
  return mockUsers;
});
async function persistRow({
  create,
}: {
  create: Omit<StagedTrigger, "id" | "createdAt" | "attempts">;
}) {
  if (!mockInTransaction) throw new Error("Staging outside transaction");
  const existing = mockRows.get(create.transactionId);
  if (existing) return existing;
  const row: StagedTrigger = {
    ...create,
    id: create.transactionId,
    createdAt: new Date(),
    attempts: 0,
  };
  mockRows.set(row.transactionId, row);
  return row;
}
const mockUpsert = jest.fn(persistRow);
const mockTrigger = jest.fn(async (..._args: unknown[]) => {
  if (mockInTransaction) throw new Error("Network inside transaction");
  return {};
});
const mockUpdate = jest.fn(async (..._args: unknown[]) => ({}));
const mockCapture = jest.fn();
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    user: { findMany: (...args: unknown[]) => mockGlobalRead(...args) },
    notificationOutbox: { update: (...args: unknown[]) => mockUpdate(...args) },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      const before = new Map(mockRows);
      mockInTransaction = true;
      try {
        return await fn({
          user: { findMany: (...args: unknown[]) => mockTxRead(...args) },
          notificationOutbox: {
            upsert: (...args: Parameters<typeof mockUpsert>) =>
              mockUpsert(...args),
          },
        });
      } catch (error) {
        mockRows.clear();
        before.forEach((row, key) => mockRows.set(key, row));
        throw error;
      } finally {
        mockInTransaction = false;
      }
    },
  },
}));
jest.mock("../../lib/novu/client", () => ({
  isNovuConfigured: () => mockConfigured,
  getNovuClient: () => ({
    trigger: (...args: unknown[]) => mockTrigger(...args),
  }),
}));
jest.mock("@sentry/nextjs", () => ({
  captureException: (...args: unknown[]) => mockCapture(...args),
  captureMessage: jest.fn(),
}));

import prisma from "@/lib/prisma";
import { stageBells } from "@/lib/novu/stage-bell";
import { triggerForMultiple } from "@/lib/novu/service";
import { attemptTrigger } from "@/lib/novu/outbox";

const payload = { paymentId: "payment", dashboardUrl: "/dashboard" };
const input = {
  workflowId: "payment-success",
  recipients: ["utc", "ist", "awake"],
  payload,
  dedupeKey: "capture:payment",
} as const;

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers().setSystemTime(new Date("2026-11-05T01:00:00Z"));
  mockRows.clear();
  mockConfigured = true;
  mockInTransaction = false;
  mockUsers = [
    {
      id: "utc",
      notificationPreferences: {
        quietHoursEnabled: true,
        quietHoursStart: "22:00",
        quietHoursEnd: "08:00",
        quietHoursTimezone: "UTC",
      },
    },
    {
      id: "ist",
      notificationPreferences: {
        quietHoursEnabled: true,
        quietHoursStart: "22:00",
        quietHoursEnd: "08:00",
        quietHoursTimezone: "Asia/Kolkata",
      },
    },
    { id: "awake", notificationPreferences: { quietHoursEnabled: false } },
  ];
});
afterEach(() => jest.useRealTimers());

it("stages each recipient with its own floor using only the transaction", async () => {
  const staged = await prisma.$transaction((tx) =>
    stageBells(tx, { ...input, recipients: [...input.recipients] }),
  );
  expect(staged.map((row) => [row.recipients, row.notBefore])).toEqual([
    [["utc"], new Date("2026-11-05T08:00:01Z")],
    [["ist"], new Date("2026-11-05T02:30:01Z")],
    [["awake"], null],
  ]);
  expect(staged.every((row) => row.kind === "SINGLE")).toBe(true);
  expect(mockGlobalRead).not.toHaveBeenCalled();
  expect(mockTrigger).not.toHaveBeenCalled();
});

it("keeps a recipient's identity and frozen floor when another recipient or settings change", async () => {
  const first = await prisma.$transaction((tx) =>
    stageBells(tx, { ...input, recipients: [...input.recipients] }),
  );
  mockUsers[0].notificationPreferences = { quietHoursEnabled: false };
  mockUsers[1].notificationPreferences = { inAppEnabled: false };
  const second = await prisma.$transaction((tx) =>
    stageBells(tx, { ...input, recipients: ["awake", "utc", "utc"] }),
  );
  expect(second).toEqual([first[2], first[0]]);
  expect(mockRows.size).toBe(3);
});

it("cancels only a revoked recipient while delivering the other original key", async () => {
  const staged = await prisma.$transaction((tx) =>
    stageBells(tx, {
      ...input,
      recipients: ["utc", "awake"],
      deferrable: false,
    }),
  );
  mockUsers[0].notificationPreferences = { inAppEnabled: false };
  expect(await attemptTrigger(staged[0])).toEqual({
    success: true,
    outcome: "DEAD_LETTER",
  });
  expect(await attemptTrigger(staged[1])).toEqual({
    success: true,
    outcome: "SENT",
  });
  expect(mockTrigger).toHaveBeenCalledTimes(1);
  expect(mockTrigger).toHaveBeenCalledWith(
    expect.objectContaining({
      to: "awake",
      transactionId: staged[1].transactionId,
    }),
    staged[1].transactionId,
  );
});

it("rolls back partial staging and sends nothing when persistence fails", async () => {
  mockUpsert
    .mockImplementationOnce(persistRow)
    .mockRejectedValueOnce(new Error("write unavailable"));
  const result = await triggerForMultiple(
    "payment-success",
    ["utc", "awake"],
    payload,
    "capture:payment",
  );
  expect(result[0].success).toBe(false);
  expect(mockRows.size).toBe(0);
  expect(mockTrigger).not.toHaveBeenCalled();
  expect(mockCapture).toHaveBeenCalledTimes(1);
});

it("commits all rows before starting at most five provider calls", async () => {
  mockUsers = Array.from({ length: 8 }, (_, i) => ({ id: `user-${i}` }));
  mockTrigger.mockImplementation(async () => {
    expect(mockInTransaction).toBe(false);
    expect(mockRows.size).toBe(8);
    return {};
  });
  const result = await triggerForMultiple(
    "payment-success",
    mockUsers.map((user) => user.id),
    payload,
    "capture:payment",
  );
  expect(mockTrigger).toHaveBeenCalledTimes(5);
  expect(result).toHaveLength(8);
  expect(
    result.slice(5).every((item) => item.staged?.status === "PENDING"),
  ).toBe(true);
});

it("retains durable work without provider configuration", async () => {
  mockConfigured = false;
  const result = await triggerForMultiple(
    "payment-success",
    ["utc", "awake"],
    payload,
    "capture:payment",
  );
  expect(mockRows.size).toBe(2);
  expect(result.every((item) => !item.success && item.staged)).toBe(true);
  expect(mockTrigger).not.toHaveBeenCalled();
});

it("reports one aggregate for a failed fan-out", async () => {
  mockUsers = [{ id: "one" }, { id: "two" }, { id: "three" }];
  mockTrigger.mockRejectedValue(new Error("provider unavailable"));
  const result = await triggerForMultiple(
    "payment-success",
    mockUsers.map((user) => user.id),
    payload,
    "capture:payment",
  );
  expect(result.every((item) => !item.success)).toBe(true);
  expect(mockCapture).toHaveBeenCalledTimes(1);
});
