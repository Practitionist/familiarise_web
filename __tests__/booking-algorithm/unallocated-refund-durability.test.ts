/** @jest-environment node */
import { Prisma } from "@prisma/client";
import type { RefundOwedOutcome } from "../../lib/payments/operations/refund-owed";

const mockDrive = jest.fn<Promise<RefundOwedOutcome>, unknown[]>(async () => ({
  kind: "settled",
}));
const mockFlush = jest.fn<Promise<void>, unknown[]>(async () => undefined);
const mockBell = jest.fn<Promise<void>, unknown[]>(async () => undefined);
const mockExpiredNotice = jest.fn<Promise<void>, unknown[]>(
  async () => undefined,
);
let mockNow = 0;
let mockFailStamp = false;
let mockFresh: string[] = [];
let mockPendingConsultations: string[] = [];
let mockApprovedUnallocated: string[] = [];
let mockLegacy: string[] = [];
let mockLegacyApproved: string[] = [];
let mockDue = new Map<string, string[]>();
let mockMarkers = new Map<string, string>();
let mockMarkerPaise = new Map<string, number | null>();
let mockMarkerAttempts = new Map<string, number>();
let mockExpired = new Set<string>();
let mockHistory: string[] = [];
let mockCasWins = true;
let mockMarkerRacePaymentId: string | null = null;
let mockMarkerRaceObserved = false;

const paymentRows = (ids: string[]) =>
  ids.map((id) => ({
    id,
    refundOwedKey: mockMarkers.get(id) ?? null,
    refundOwedPaise: mockMarkerPaise.get(id) ?? null,
    refundOwedAttempts: mockMarkerAttempts.get(id) ?? 0,
  }));

const row = (id: string) => ({
  id,
  appointment: { id: `a-${id}`, organizationId: null, occurrences: [] },
  requestedBy: { user: { id: "buyer", name: "Buyer" } },
  subscriptionPlan: {
    title: "Plan",
    consultantProfile: { id: "expert", user: { id: "expert", name: "Expert" } },
  },
  consultationPlan: {
    title: "Plan",
    consultantProfile: { user: { name: "Expert" } },
  },
});

jest.mock("../../lib/cron/with-cron-lock", () => ({
  withCronLock: (_name: string, _opts: unknown, fn: () => unknown) => fn(),
}));
jest.mock("../../lib/prisma", () => {
  const db = {
    consultation: {
      findMany: jest.fn(
        async ({ where }: { where: Prisma.ConsultationWhereInput }) =>
          where.status === "PENDING" ? mockPendingConsultations.map(row) : [],
      ),
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => ({
        status: "PENDING",
        appointment: { id: `a-${where.id}` },
      })),
      updateMany: jest.fn(async ({ where }: { where: { id: string } }) => {
        if (!mockCasWins) return { count: 0 };
        mockExpired.add(`consultation:${where.id}`);
        return { count: 1 };
      }),
    },
    subscription: {
      findMany: jest.fn(
        async ({ where }: { where: Prisma.SubscriptionWhereInput }) =>
          where.status === "APPROVED"
            ? mockApprovedUnallocated.map(row)
            : where.AND && JSON.stringify(where.AND).includes("RESCHEDULED")
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
    appointmentOccurrence: {
      findMany: jest.fn(async () => []),
      updateManyAndReturn: jest.fn(async () => []),
    },
    windowBackupInterest: { updateMany: jest.fn(async () => ({ count: 0 })) },
    $queryRaw: jest.fn(async (query: Prisma.Sql) => {
      const limit = query.values.at(-1);
      if (
        query.text.includes('"Subscription"') &&
        query.text.includes('h."fromStatus"')
      ) {
        return mockLegacyApproved
          .filter((id) => !mockMarkers.has(id))
          .slice(0, Number(limit))
          .map((id) => ({ id }));
      }
      if (query.text.includes('p."refundOwedKey" IS NOT NULL')) {
        return [...mockMarkers.keys()]
          .slice(0, Number(limit))
          .map((id) => ({ id }));
      }
      if (query.text.includes('a."consultationId"')) {
        const ids = mockDue.get(String(query.values[0])) ?? [];
        return paymentRows(ids);
      }
      if (
        query.text.includes('a."subscriptionId"') &&
        !query.text.includes('p."refundOwedKey" IS NULL')
      ) {
        const ids = mockDue.get(String(query.values[0])) ?? [];
        return paymentRows(ids);
      }
      if (typeof limit !== "number") throw new Error("missing query bound");
      const ids = query.text.includes('JOIN "Subscription"')
        ? mockLegacy.filter((id) => !mockMarkers.has(id))
        : (mockDue.get(String(query.values[0])) ?? []);
      return ids.slice(0, limit).map((id) => ({ id }));
    }),
    $executeRaw: jest.fn(async (query: Prisma.Sql) => {
      if (mockFailStamp) throw new Error("stamp failed");
      const ids = query.values[0];
      const keys = query.values[1];
      const owed = query.values[2];
      if (!Array.isArray(ids) || !Array.isArray(keys) || !Array.isArray(owed))
        throw new Error("missing marker ids or keys");
      if (
        mockMarkerRacePaymentId &&
        !mockMarkerRaceObserved &&
        ids.map(String).includes(mockMarkerRacePaymentId)
      ) {
        mockMarkerRaceObserved = true;
        mockMarkers.set(mockMarkerRacePaymentId, "other-door:concurrent");
        mockMarkerPaise.set(mockMarkerRacePaymentId, null);
        mockMarkerAttempts.set(mockMarkerRacePaymentId, 4);
        return Number(ids.length) - 1;
      }
      ids.forEach((id, index) => {
        const paymentId = String(id);
        mockMarkers.set(paymentId, String(keys[index]));
        mockMarkerPaise.set(
          paymentId,
          owed[index] === null ? null : Number(owed[index]),
        );
        mockMarkerAttempts.set(paymentId, 0);
      });
      return ids.length;
    }),
    $transaction: jest.fn(
      async (fn: (tx: unknown) => Promise<unknown>): Promise<unknown> => {
        const before = {
          markers: new Map(mockMarkers),
          markerPaise: new Map(mockMarkerPaise),
          markerAttempts: new Map(mockMarkerAttempts),
          expired: new Set(mockExpired),
          history: [...mockHistory],
        };
        try {
          return await fn(db);
        } catch (error) {
          const racedMarker =
            mockMarkerRaceObserved && mockMarkerRacePaymentId
              ? {
                  id: mockMarkerRacePaymentId,
                  key: mockMarkers.get(mockMarkerRacePaymentId),
                  paise: mockMarkerPaise.get(mockMarkerRacePaymentId),
                  attempts: mockMarkerAttempts.get(mockMarkerRacePaymentId),
                }
              : null;
          mockMarkers = before.markers;
          mockMarkerPaise = before.markerPaise;
          mockMarkerAttempts = before.markerAttempts;
          mockExpired = before.expired;
          mockHistory = before.history;
          if (racedMarker?.key !== undefined) {
            mockMarkers.set(racedMarker.id, racedMarker.key);
            mockMarkerPaise.set(racedMarker.id, racedMarker.paise ?? null);
            mockMarkerAttempts.set(racedMarker.id, racedMarker.attempts ?? 0);
          }
          throw error;
        }
      },
    ),
  };
  return { __esModule: true, default: db };
});
jest.mock("../../lib/payments/operations/refund-owed", () => ({
  ...jest.requireActual<
    typeof import("../../lib/payments/operations/refund-owed")
  >("../../lib/payments/operations/refund-owed"),
  driveRefundOwed: (...args: unknown[]) => mockDrive(...args),
}));
jest.mock("../../lib/payments/operations/refund", () => ({}));
jest.mock("../../lib/payments/operations/booking-refund", () => ({
  refundBookingPayment: jest.fn(),
}));
jest.mock("../../lib/booking/expiry-notices", () => ({
  notifyConsulteeRequestExpired: (...args: unknown[]) =>
    mockExpiredNotice(...args),
}));
jest.mock("../../lib/booking/backup-interest", () => ({
  expireBackupInterest: jest.fn(async () => ({ count: 0 })),
}));
jest.mock("../../lib/novu/service", () => ({
  notifyUnscheduledSubscriptionNudge: jest.fn(),
}));
jest.mock("../../lib/novu/outbox", () => ({ deriveTransactionId: jest.fn() }));
jest.mock("../../lib/novu/stage-bell", () => ({
  stageBell: (...args: unknown[]) => mockBell(...args),
}));
jest.mock("../../lib/novu/stage-then-attempt", () => ({
  flushNotificationsAfter: (...args: unknown[]) => mockFlush(...args),
}));
jest.mock("../../lib/email", () => ({ EMAIL_BUDGET_MS: { JOB: 1 } }));
jest.mock("../../lib/email/senders/booking", () => ({
  stageAppointmentCancelledEmail: jest.fn(async () => []),
}));

import prisma from "../../lib/prisma";
import {
  expireStaleRequests,
  expireUnallocatedPaidSubscriptionForOne,
} from "../../scripts/appointments/expire-stale-requests";

beforeEach(() => {
  jest.clearAllMocks();
  mockNow = Date.parse("2026-10-24T10:00:00Z");
  jest.spyOn(Date, "now").mockImplementation(() => mockNow);
  mockFresh = ["sub-1"];
  mockPendingConsultations = [];
  mockApprovedUnallocated = [];
  mockLegacy = [];
  mockLegacyApproved = [];
  mockDue = new Map([["sub-1", ["pay-1"]]]);
  mockMarkers = new Map();
  mockMarkerPaise = new Map();
  mockMarkerAttempts = new Map();
  mockExpired = new Set();
  mockHistory = [];
  mockFailStamp = false;
  mockCasWins = true;
  mockMarkerRacePaymentId = null;
  mockMarkerRaceObserved = false;
  mockDrive.mockResolvedValue({ kind: "settled" });
  mockFlush.mockResolvedValue(undefined);
  mockExpiredNotice.mockResolvedValue(undefined);
});
afterEach(() => jest.restoreAllMocks());

const expiryArms = [
  {
    arm: "pending consultation",
    entityId: "consult-1",
    expiredId: "consultation:consult-1",
    paymentId: "pay-consult-1",
    key: "pending-consultation:pay-consult-1",
    prepare: () => {
      mockFresh = [];
      mockDue.clear();
      mockPendingConsultations = ["consult-1"];
      mockDue.set("consult-1", ["pay-consult-1"]);
    },
  },
  {
    arm: "approved unallocated subscription",
    entityId: "approved-1",
    expiredId: "approved-1",
    paymentId: "pay-approved-1",
    key: "approved-unallocated:pay-approved-1",
    prepare: () => {
      mockFresh = [];
      mockDue.clear();
      mockApprovedUnallocated = ["approved-1"];
      mockDue.set("approved-1", ["pay-approved-1"]);
    },
  },
];

it.each(expiryArms)(
  "stages $arm refund debt atomically before driving",
  async ({ prepare, expiredId, paymentId, key }) => {
    prepare();
    mockDrive.mockImplementation(async () => {
      expect(mockExpired.has(expiredId)).toBe(true);
      expect(mockMarkers.get(paymentId)).toBe(key);
      return { kind: "settled" };
    });

    const result = await expireStaleRequests({ limits: { maxRequests: 2 } });

    expect(mockDrive).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentId,
        amountPaise: null,
        key,
        reason: expect.stringContaining("automatic full refund"),
      }),
    );
    expect(result.refundsIssued).toBe(0);
    expect(result.success).toBe(true);
  },
);

it.each(expiryArms)(
  "expires $arm without replacing an existing full-balance marker",
  async ({ prepare, expiredId, paymentId }) => {
    prepare();
    const key = "other-door:full-balance";
    mockMarkers.set(paymentId, key);
    mockMarkerPaise.set(paymentId, null);
    mockMarkerAttempts.set(paymentId, 2);

    await expireStaleRequests({ limits: { maxRequests: 2 } });

    expect(mockExpired.has(expiredId)).toBe(true);
    expect(mockMarkers.get(paymentId)).toBe(key);
    expect(mockMarkerPaise.get(paymentId)).toBeNull();
    expect(mockMarkerAttempts.get(paymentId)).toBe(2);
    expect(mockDrive).not.toHaveBeenCalled();
  },
);

it.each(expiryArms)(
  "holds $arm when an existing marker only covers a partial amount",
  async ({ prepare, expiredId, paymentId }) => {
    prepare();
    const key = "other-door:partial";
    mockMarkers.set(paymentId, key);
    mockMarkerPaise.set(paymentId, 500);
    mockMarkerAttempts.set(paymentId, 1);

    await expireStaleRequests({ limits: { maxRequests: 2 } });

    expect(mockExpired.has(expiredId)).toBe(false);
    expect(mockMarkers.get(paymentId)).toBe(key);
    expect(mockMarkerPaise.get(paymentId)).toBe(500);
    expect(mockMarkerAttempts.get(paymentId)).toBe(1);
    expect(mockDrive).not.toHaveBeenCalled();
  },
);

it.each(expiryArms)(
  "rolls back $arm expiry when owed-marker staging fails",
  async ({ prepare, paymentId }) => {
    prepare();
    mockFailStamp = true;

    const result = await expireStaleRequests({ limits: { maxRequests: 2 } });

    expect(mockExpired.size).toBe(0);
    expect(mockMarkers.has(paymentId)).toBe(false);
    expect(mockHistory).toEqual([]);
    expect(mockExpiredNotice).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(mockDrive).not.toHaveBeenCalled();
  },
);

it.each(expiryArms)(
  "stages no $arm marker when the status CAS loses",
  async ({ prepare }) => {
    prepare();
    mockCasWins = false;

    await expireStaleRequests({ limits: { maxRequests: 2 } });

    expect(mockExpired.size).toBe(0);
    expect(mockHistory).toEqual([]);
    expect(mockMarkers.size).toBe(0);
    expect(mockDrive).not.toHaveBeenCalled();
  },
);

it("rolls back one request on a marker-count race and continues to the next consultation", async () => {
  mockFresh = [];
  mockDue.clear();
  mockPendingConsultations = ["consult-race", "consult-later"];
  mockDue.set("consult-race", ["pay-race"]);
  mockDue.set("consult-later", ["pay-later"]);
  mockMarkerRacePaymentId = "pay-race";

  const result = await expireStaleRequests({ limits: { maxRequests: 2 } });

  expect(result.consultationsExpired).toBe(1);
  expect(result.errors).toEqual([]);
  expect(mockExpired.has("consultation:consult-race")).toBe(false);
  expect(mockExpired.has("consultation:consult-later")).toBe(true);
  expect(mockHistory).toEqual(["consult-later"]);
  expect(mockMarkers.get("pay-race")).toBe("other-door:concurrent");
  expect(mockMarkerPaise.get("pay-race")).toBeNull();
  expect(mockMarkerAttempts.get("pay-race")).toBe(4);
  expect(mockMarkers.get("pay-later")).toBe("pending-consultation:pay-later");
  expect(mockDrive).toHaveBeenCalledTimes(1);
  expect(mockDrive).toHaveBeenCalledWith(
    expect.objectContaining({
      paymentId: "pay-later",
      key: "pending-consultation:pay-later",
      amountPaise: null,
    }),
  );
});

it("leaves the committed consultation refund marker durable if notification fails", async () => {
  mockPendingConsultations = ["consult-1"];
  mockFresh = [];
  mockDue.clear();
  mockDue.set("consult-1", ["pay-consult-1"]);
  mockExpiredNotice.mockRejectedValue(new Error("notice failed"));

  await expireStaleRequests({ limits: { maxRequests: 2 } });

  expect(mockExpired.has("consultation:consult-1")).toBe(true);
  expect(mockMarkers.get("pay-consult-1")).toBe(
    "pending-consultation:pay-consult-1",
  );
  expect(mockDrive).not.toHaveBeenCalled();
});

it("boundedly backfills exact historical approved-expiry transitions under the stable refund key", async () => {
  mockLegacyApproved = ["legacy-approved-pay-1", "legacy-approved-pay-2"];
  mockFresh = [];
  mockDue.clear();

  await expireStaleRequests({ limits: { maxRequests: 1 } });

  expect([...mockMarkers]).toEqual([
    ["legacy-approved-pay-1", "approved-unallocated:legacy-approved-pay-1"],
  ]);
  await expireStaleRequests({ limits: { maxRequests: 1 } });
  expect(mockMarkers.get("legacy-approved-pay-2")).toBe(
    "approved-unallocated:legacy-approved-pay-2",
  );
  const scans = jest.mocked(prisma.$queryRaw).mock.calls.map(([query]) => {
    if (!("text" in query))
      throw new Error("Expected a parameterized SQL query");
    return query;
  });
  const legacyScan = scans.find(
    (query) =>
      query.text.includes('"Subscription"') &&
      query.text.includes('h."fromStatus"'),
  );
  expect(legacyScan).toBeDefined();
  expect(legacyScan?.text).toContain('h."actorUserId" IS NULL');
  expect(legacyScan?.text.indexOf("GREATEST")).toBeLessThan(
    legacyScan?.text.indexOf("LIMIT") ?? -1,
  );
});

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

it("keeps retained obligations visible without driving or replacing another door's marker", async () => {
  mockFresh = [];
  mockLegacy = [];
  mockDue.clear();
  mockMarkers.set("foreign", "other-door");
  mockMarkers.set("retained", "sub-unalloc:retained");
  const result = await expireStaleRequests({ limits: { maxRequests: 1 } });
  expect(result).toMatchObject({
    success: true,
    unallocatedHasMore: true,
    refundsIssued: 0,
  });
  expect(mockDrive).not.toHaveBeenCalled();
  expect(mockMarkers).toEqual(
    new Map([
      ["foreign", "other-door"],
      ["retained", "sub-unalloc:retained"],
    ]),
  );
});
