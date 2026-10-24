/** @jest-environment node */
import { Prisma } from "@prisma/client";
import type { RefundOwedOutcome } from "@/lib/payments/operations/refund-owed";

const mockDrive = jest.fn<Promise<RefundOwedOutcome>, unknown[]>(async () => ({
  kind: "settled",
}));
const mockFlush = jest.fn<Promise<void>, unknown[]>(async () => undefined);
const mockBell = jest.fn<Promise<void>, unknown[]>(async () => undefined);
let mockNow = 0;
let mockFailStamp = false;
let mockFresh: string[] = [];
let mockLegacy: string[] = [];
let mockDue = new Map<string, string[]>();
let mockMarkers = new Map<string, string>();
let mockExpired = new Set<string>();
let mockHistory: string[] = [];
let mockCasWins = true;

const row = (id: string) => ({
  id,
  appointment: { id: `a-${id}`, organizationId: null, occurrences: [] },
  requestedBy: { user: { id: "buyer", name: "Buyer" } },
  subscriptionPlan: {
    title: "Plan",
    consultantProfile: { id: "expert", user: { id: "expert", name: "Expert" } },
  },
});

jest.mock("@/lib/cron/with-cron-lock", () => ({
  withCronLock: (_name: string, _opts: unknown, fn: () => unknown) => fn(),
}));
jest.mock("@/lib/prisma", () => {
  const db = {
    consultation: { findMany: jest.fn(async () => []) },
    subscription: {
      findMany: jest.fn(
        async ({ where }: { where: Prisma.SubscriptionWhereInput }) =>
          where.AND && JSON.stringify(where.AND).includes("RESCHEDULED")
            ? mockFresh.map(row)
            : [],
      ),
      findFirst: jest.fn(async () => (mockFresh[0] ? row(mockFresh[0]) : null)),
      findUnique: jest.fn(async () => ({
        status: "PENDING",
        appointment: { id: "a" },
      })),
      updateMany: jest.fn(async ({ where }: { where: { id: string } }) => {
        if (!mockCasWins) return { count: 0 };
        mockExpired.add(where.id);
        return { count: 1 };
      }),
    },
    bookingStatusHistory: {
      findMany: jest.fn(async () =>
        mockLegacy.map((entityId) => ({ entityId })),
      ),
      create: jest.fn(async ({ data }: { data: { entityId: string } }) => {
        mockHistory.push(data.entityId);
      }),
    },
    payment: {
      findMany: jest.fn(async () =>
        [...mockMarkers].map(([id, key]) => ({
          id,
          refundOwedKey: key,
          refundOwedPaise: null,
          refundOwedReason: "owed",
          refundOwedAttempts: 0,
        })),
      ),
    },
    refund: { findMany: jest.fn(async () => []) },
    appointment: { findMany: jest.fn(async () => []) },
    appointmentOccurrence: { findMany: jest.fn(async () => []) },
    windowBackupInterest: { updateMany: jest.fn(async () => ({ count: 0 })) },
    $queryRaw: jest.fn(async (query: Prisma.Sql) => {
      const limit = query.values.at(-1);
      if (typeof limit !== "number") throw new Error("missing query bound");
      if (query.text.includes('p."refundOwedKey" IS NOT NULL')) {
        return [...mockMarkers.keys()].slice(0, limit).map((id) => ({ id }));
      }
      const ids = query.text.includes('JOIN "Subscription"')
        ? mockLegacy.filter((id) => !mockMarkers.has(id))
        : (mockDue.get(String(query.values[0])) ?? []);
      return ids.slice(0, limit).map((id) => ({ id }));
    }),
    $executeRaw: jest.fn(async (query: Prisma.Sql) => {
      if (mockFailStamp) throw new Error("stamp failed");
      const ids = query.values[0];
      if (!Array.isArray(ids)) throw new Error("missing marker ids");
      for (const id of ids) mockMarkers.set(String(id), `sub-unalloc:${id}`);
      return ids.length;
    }),
    $transaction: jest.fn(
      async (fn: (tx: unknown) => Promise<unknown>): Promise<unknown> => {
        const before = {
          markers: new Map(mockMarkers),
          expired: new Set(mockExpired),
          history: [...mockHistory],
        };
        try {
          return await fn(db);
        } catch (error) {
          mockMarkers = before.markers;
          mockExpired = before.expired;
          mockHistory = before.history;
          throw error;
        }
      },
    ),
  };
  return { __esModule: true, default: db };
});
jest.mock("@/lib/payments/operations/refund-owed", () => ({
  ...jest.requireActual<typeof import("@/lib/payments/operations/refund-owed")>(
    "@/lib/payments/operations/refund-owed",
  ),
  driveRefundOwed: (...args: unknown[]) => mockDrive(...args),
}));
jest.mock("@/lib/payments/operations/refund", () => ({}));
jest.mock("@/lib/payments/operations/booking-refund", () => ({
  refundBookingPayment: jest.fn(),
}));
jest.mock("@/lib/booking/expiry-notices", () => ({
  notifyConsulteeRequestExpired: jest.fn(),
}));
jest.mock("@/lib/booking/backup-interest", () => ({
  expireBackupInterest: jest.fn(async () => ({ count: 0 })),
}));
jest.mock("@/lib/novu/service", () => ({
  notifyUnscheduledSubscriptionNudge: jest.fn(),
}));
jest.mock("@/lib/novu/outbox", () => ({ deriveTransactionId: jest.fn() }));
jest.mock("@/lib/novu/stage-bell", () => ({
  stageBell: (...args: unknown[]) => mockBell(...args),
}));
jest.mock("@/lib/novu/stage-then-attempt", () => ({
  flushNotificationsAfter: (...args: unknown[]) => mockFlush(...args),
}));
jest.mock("@/lib/email", () => ({ EMAIL_BUDGET_MS: { JOB: 1 } }));
jest.mock("@/lib/email/senders/booking", () => ({
  stageAppointmentCancelledEmail: jest.fn(async () => []),
}));

import prisma from "@/lib/prisma";
import {
  expireStaleRequests,
  expireUnallocatedPaidSubscriptionForOne,
} from "@/scripts/appointments/expire-stale-requests";

beforeEach(() => {
  jest.clearAllMocks();
  mockNow = Date.parse("2026-10-24T10:00:00Z");
  jest.spyOn(Date, "now").mockImplementation(() => mockNow);
  mockFresh = ["sub-1"];
  mockLegacy = [];
  mockDue = new Map([["sub-1", ["pay-1"]]]);
  mockMarkers = new Map();
  mockExpired = new Set();
  mockHistory = [];
  mockFailStamp = false;
  mockCasWins = true;
  mockDrive.mockResolvedValue({ kind: "settled" });
  mockFlush.mockResolvedValue(undefined);
});
afterEach(() => jest.restoreAllMocks());

it("commits expiry/history/bell and full-balance marker before any drive", async () => {
  mockDrive.mockImplementation(async () => {
    expect(mockExpired.has("sub-1")).toBe(true);
    expect(mockHistory).toEqual(["sub-1"]);
    expect(mockMarkers.get("pay-1")).toBe("sub-unalloc:pay-1");
    expect(mockBell).toHaveBeenCalledTimes(1);
    return { kind: "settled" };
  });
  const result = await expireStaleRequests({ limits: { maxRequests: 2 } });
  expect(result.subscriptionsExpired).toBe(1);
  expect(mockDrive).toHaveBeenCalledWith(
    expect.objectContaining({
      paymentId: "pay-1",
      amountPaise: null,
      key: "sub-unalloc:pay-1",
    }),
  );
  expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
    isolationLevel: "Serializable",
  });
});

it("retains a durable marker when the family deadline expires after commit", async () => {
  mockFlush.mockImplementation(async () => {
    mockNow += 16_000;
  });
  const result = await expireStaleRequests({ limits: { maxRequests: 2 } });
  expect(mockExpired.has("sub-1")).toBe(true);
  expect(mockMarkers.get("pay-1")).toBe("sub-unalloc:pay-1");
  expect(mockDrive).not.toHaveBeenCalled();
  expect(result.unallocatedRefundsDeferred).toBe(1);
  expect(result.unallocatedHasMore).toBe(true);
});

it("rolls back expiry/history and stages no bell when marker persistence fails", async () => {
  mockFailStamp = true;
  const result = await expireStaleRequests({ limits: { maxRequests: 2 } });
  expect(mockExpired.size).toBe(0);
  expect(mockHistory).toEqual([]);
  expect(mockBell).not.toHaveBeenCalled();
  expect(result.success).toBe(false);
  expect(result.unallocatedHasMore).toBe(true);
});

it("holds an oversized payment envelope instead of committing only its first liabilities", async () => {
  mockDue.set("sub-1", ["pay-1", "pay-2", "pay-3"]);
  const result = await expireStaleRequests({ limits: { maxRequests: 2 } });
  expect(mockExpired.size).toBe(0);
  expect(mockMarkers.size).toBe(0);
  expect(mockBell).not.toHaveBeenCalled();
  expect(result.errors.join(" ")).toContain("payment envelope");
  expect(result.unallocatedHasMore).toBe(true);
});

it("defers a plan that fits a fresh envelope when only this invocation's allowance is exhausted", async () => {
  mockFresh = ["sub-1", "sub-2", "sub-3"];
  mockDue = new Map([
    ["sub-1", ["pay-1", "pay-2"]],
    ["sub-2", ["pay-3", "pay-4"]],
    ["sub-3", ["pay-5"]],
  ]);
  const first = await expireStaleRequests({ limits: { maxRequests: 3 } });
  expect(first.success).toBe(true);
  expect(first.errors).toEqual([]);
  expect(first.unallocatedHasMore).toBe(true);
  expect([...mockExpired]).toEqual(["sub-1"]);
  expect([...mockMarkers.keys()]).toEqual(["pay-1", "pay-2"]);
  expect(mockHistory).toEqual(["sub-1"]);
  expect(mockBell).toHaveBeenCalledTimes(1);

  mockFresh = ["sub-2", "sub-3"];
  const second = await expireStaleRequests({ limits: { maxRequests: 3 } });
  expect(second.success).toBe(true);
  expect([...mockExpired]).toEqual(["sub-1", "sub-2", "sub-3"]);
  expect([...mockMarkers.keys()]).toEqual([
    "pay-1",
    "pay-2",
    "pay-3",
    "pay-4",
    "pay-5",
  ]);
});

it("stages nothing for a lost allocation/reschedule CAS", async () => {
  mockCasWins = false;
  const result = await expireStaleRequests({ limits: { maxRequests: 2 } });
  expect(result.subscriptionsExpired).toBe(0);
  expect(mockMarkers.size).toBe(0);
  expect(mockBell).not.toHaveBeenCalled();
  expect(mockDrive).not.toHaveBeenCalled();
});

it("shares the deadline across legacy and fresh phases", async () => {
  mockLegacy = ["legacy-1"];
  mockDrive.mockImplementation(async () => {
    mockNow += 16_000;
    return { kind: "settled" };
  });
  const result = await expireStaleRequests({ limits: { maxRequests: 2 } });
  expect(mockDrive).toHaveBeenCalledTimes(1);
  expect(mockMarkers.size).toBe(2);
  expect(result.unallocatedRefundsDeferred).toBe(1);
});

it("advances a capped legacy cohort across invocations without a cursor", async () => {
  mockFresh = [];
  mockLegacy = ["a", "b", "c"];
  const first = await expireStaleRequests({ limits: { maxRequests: 2 } });
  expect(first.unallocatedHasMore).toBe(true);
  expect([...mockMarkers.keys()]).toEqual(["a", "b"]);
  await expireStaleRequests({ limits: { maxRequests: 2 } });
  expect([...mockMarkers.keys()]).toEqual(["a", "b", "c"]);
});

it("keeps an in-flight refund visible as deferred work", async () => {
  mockDrive.mockResolvedValue({
    kind: "refunded",
    refund: { refundId: "rf", amountRefundedPaise: 100, status: "PENDING" },
  });
  const result = await expireStaleRequests({ limits: { maxRequests: 2 } });
  expect(result.refundsIssued).toBe(1);
  expect(result.unallocatedRefundsDeferred).toBe(1);
  expect(result.unallocatedHasMore).toBe(true);
});

it("the admin door reads and drives an already-persisted marker without restamping it", async () => {
  mockFresh = [];
  mockMarkers.set("pay-1", "sub-unalloc:pay-1");
  const result = await expireUnallocatedPaidSubscriptionForOne("sub-1");
  expect(result.expired).toBe(false);
  expect(mockDrive).toHaveBeenCalledWith(
    expect.objectContaining({ key: "sub-unalloc:pay-1" }),
  );
  expect(prisma.$executeRaw).not.toHaveBeenCalled();
  expect(prisma.payment.findMany).toHaveBeenCalledWith(
    expect.objectContaining({
      where: expect.objectContaining({
        appointment: expect.objectContaining({
          subscriptionId: "sub-1",
          subscription: { status: "EXPIRED" },
        }),
      }),
    }),
  );
});
