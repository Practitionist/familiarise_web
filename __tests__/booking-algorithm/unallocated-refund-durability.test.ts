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
let mockNoAppointmentSubscriptions = new Set<string>();
let mockLegacy: string[] = [];
let mockLegacyApproved: string[] = [];
let mockDue = new Map<string, string[]>();
let mockMarkers = new Map<string, string>();
let mockMarkerPaise = new Map<string, number | null>();
let mockMarkerReasons = new Map<string, string>();
let mockMarkerAttempts = new Map<string, number>();
let mockExpired = new Set<string>();
let mockHistory: string[] = [];
let mockCasWins = true;
let mockMarkerRacePaymentId: string | null = null;
let mockMarkerRaceObserved = false;
let mockBeforeConsultationCohortRead: (() => void) | null = null;
let mockBeforeApprovedCohortRead: (() => void) | null = null;

const paymentRows = (ids: string[]) =>
  ids.map((id) => ({
    id,
    refundOwedKey: mockMarkers.get(id) ?? null,
    refundOwedPaise: mockMarkerPaise.get(id) ?? null,
    refundOwedAttempts: mockMarkerAttempts.get(id) ?? 0,
  }));

const hasPartialRefundMarker = (entityId: string) =>
  (mockDue.get(entityId) ?? []).some(
    (paymentId) =>
      mockMarkers.has(paymentId) &&
      mockMarkerPaise.get(paymentId) !== null &&
      mockMarkerPaise.has(paymentId),
  );

const row = (id: string) => ({
  id,
  appointment: mockNoAppointmentSubscriptions.has(id)
    ? null
    : { id: `a-${id}`, organizationId: null, occurrences: [] },
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

// The notify-me hooks are pinned by their own suites; here they stage nothing.
jest.mock("@/lib/booking/event-waitlist", () => ({
  stageSeatOpenedNotices: jest.fn(async () => ({ pages: [], email: null })),
  finishSeatOpenedNotices: jest.fn(async () => undefined),
  markEventWaitlistBooked: jest.fn(async () => ({ count: 0 })),
  expireEventWaitlist: jest.fn(async () => ({ expired: 0, purged: 0 })),
  hasLapsedEventWaitlist: jest.fn(async () => false),
}));
jest.mock("../../lib/cron/with-cron-lock", () => ({
  withCronLock: (_name: string, _opts: unknown, fn: () => unknown) => fn(),
}));
jest.mock("../../lib/prisma", () => {
  const db = {
    consultation: {
      findMany: jest.fn(
        async ({
          where,
          take,
          select,
        }: {
          where: Prisma.ConsultationWhereInput;
          take?: number;
          select?: Prisma.ConsultationSelect;
        }) => {
          if (!JSON.stringify(where).includes('"PENDING"')) return [];
          const whereText = JSON.stringify(where);
          // The request-expiring alert's window read: nothing lapses soon here.
          if (whereText.includes('"requestedAt":{"gte"')) return [];
          const partialMarkerQuery = whereText.includes(
            '"refundOwedPaise":{"not":null}',
          );
          const heldPresenceQuery =
            partialMarkerQuery &&
            select?.id === true &&
            Object.keys(select).length === 1;
          if (partialMarkerQuery && !heldPresenceQuery) {
            mockBeforeConsultationCohortRead?.();
            mockBeforeConsultationCohortRead = null;
          }
          const ids = mockPendingConsultations.filter((id) =>
            heldPresenceQuery
              ? hasPartialRefundMarker(id)
              : !partialMarkerQuery || !hasPartialRefundMarker(id),
          );
          return ids.slice(0, take ?? ids.length).map(row);
        },
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
    // The week-reminder scan sizes its consultant rotation first.
    consultantProfile: {
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
    },
    subscription: {
      findMany: jest.fn(
        async ({
          where,
          take,
          select,
        }: {
          where: Prisma.SubscriptionWhereInput;
          take?: number;
          select?: Prisma.SubscriptionSelect;
        }) => {
          const whereText = JSON.stringify(where);
          const partialMarkerQuery = whereText.includes(
            '"refundOwedPaise":{"not":null}',
          );
          const heldPresenceQuery =
            partialMarkerQuery &&
            select?.id === true &&
            Object.keys(select).length === 1;
          const isApprovedCohort = whereText.includes('"APPROVED"');
          if (isApprovedCohort) {
            if (partialMarkerQuery && !heldPresenceQuery) {
              mockBeforeApprovedCohortRead?.();
              mockBeforeApprovedCohortRead = null;
            }
            const ids = mockApprovedUnallocated.filter((id) =>
              heldPresenceQuery
                ? hasPartialRefundMarker(id)
                : !partialMarkerQuery || !hasPartialRefundMarker(id),
            );
            return ids.slice(0, take ?? ids.length).map(row);
          }
          return where.AND && JSON.stringify(where.AND).includes("RESCHEDULED")
            ? mockFresh.map(row)
            : [];
        },
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
          refundOwedReason: mockMarkerReasons.get(id) ?? "owed",
          refundOwedAttempts: 0,
        })),
      ),
    },
    refund: { findMany: jest.fn(async () => []) },
    // The owed-refund stamp cancels the unsent payouts that batched the payment's earnings; none here.
    consultantEarnings: { findMany: jest.fn(async () => []) },
    organizationEarnings: { findMany: jest.fn(async () => []) },
    appointment: { findMany: jest.fn(async () => []) },
    appointmentOccurrence: {
      findMany: jest.fn(async () => []),
      updateManyAndReturn: jest.fn(async () => []),
    },
    windowBackupInterest: {
      updateMany: jest.fn(async () => ({ count: 0 })),
      findMany: jest.fn(async () => []),
    },
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
      const reasons = query.values[3];
      if (
        !Array.isArray(ids) ||
        !Array.isArray(keys) ||
        !Array.isArray(owed) ||
        !Array.isArray(reasons)
      )
        throw new Error("missing marker ids or keys");
      if (
        mockMarkerRacePaymentId &&
        !mockMarkerRaceObserved &&
        ids.map(String).includes(mockMarkerRacePaymentId)
      ) {
        mockMarkerRaceObserved = true;
        mockMarkers.set(mockMarkerRacePaymentId, "other-door:concurrent");
        mockMarkerPaise.set(mockMarkerRacePaymentId, null);
        mockMarkerReasons.set(mockMarkerRacePaymentId, "concurrent reason");
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
        mockMarkerReasons.set(paymentId, String(reasons[index]));
        mockMarkerAttempts.set(paymentId, 0);
      });
      return ids.length;
    }),
    $transaction: jest.fn(
      async (fn: (tx: unknown) => Promise<unknown>): Promise<unknown> => {
        const before = {
          markers: new Map(mockMarkers),
          markerPaise: new Map(mockMarkerPaise),
          markerReasons: new Map(mockMarkerReasons),
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
                  reason: mockMarkerReasons.get(mockMarkerRacePaymentId),
                  attempts: mockMarkerAttempts.get(mockMarkerRacePaymentId),
                }
              : null;
          mockMarkers = before.markers;
          mockMarkerPaise = before.markerPaise;
          mockMarkerReasons = before.markerReasons;
          mockMarkerAttempts = before.markerAttempts;
          mockExpired = before.expired;
          mockHistory = before.history;
          if (racedMarker?.key !== undefined) {
            mockMarkers.set(racedMarker.id, racedMarker.key);
            mockMarkerPaise.set(racedMarker.id, racedMarker.paise ?? null);
            mockMarkerReasons.set(racedMarker.id, racedMarker.reason ?? "");
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
  flushBackupInterestNotices: jest.fn(async () => undefined),
  stageNoticesForAppointmentHolds: jest.fn(async () => ({
    bells: [],
    emails: [],
  })),
  stageNoticesForFreedWindows: jest.fn(async () => ({ bells: [], emails: [] })),
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
  mockNoAppointmentSubscriptions = new Set();
  mockLegacy = [];
  mockLegacyApproved = [];
  mockDue = new Map([["sub-1", ["pay-1"]]]);
  mockMarkers = new Map();
  mockMarkerPaise = new Map();
  mockMarkerReasons = new Map();
  mockMarkerAttempts = new Map();
  mockExpired = new Set();
  mockHistory = [];
  mockFailStamp = false;
  mockCasWins = true;
  mockMarkerRacePaymentId = null;
  mockMarkerRaceObserved = false;
  mockBeforeConsultationCohortRead = null;
  mockBeforeApprovedCohortRead = null;
  mockDrive.mockResolvedValue({ kind: "settled" });
  mockFlush.mockResolvedValue(undefined);
  mockExpiredNotice.mockResolvedValue(undefined);
});
afterEach(() => jest.restoreAllMocks());

it("keeps stale approved subscriptions with no appointment in the expiry cohort", async () => {
  mockFresh = [];
  const subscriptionId = "approved-without-appointment";
  mockApprovedUnallocated = [subscriptionId];
  mockNoAppointmentSubscriptions.add(subscriptionId);

  await expireStaleRequests({ limits: { maxRequests: 1 } });

  expect(mockExpired.has(subscriptionId)).toBe(true);
  expect(mockHistory).toEqual([subscriptionId]);
  const approvedCohort = (prisma.subscription.findMany as jest.Mock).mock.calls
    .map(([args]) => args)
    .find(
      (args) =>
        JSON.stringify(args.where).includes('"status":"APPROVED"') &&
        JSON.stringify(args.where).includes('"refundOwedPaise":{"not":null}') &&
        JSON.stringify(args.where).includes(
          '"NOT":{"appointment":{"payment":{"some"',
        ),
    );
  expect(approvedCohort.where.AND).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        NOT: {
          appointment: {
            payment: {
              some: expect.any(Object),
            },
          },
        },
      }),
    ]),
  );
});

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
    mockMarkerAttempts.set(paymentId, 3);

    await expireStaleRequests({ limits: { maxRequests: 1 } });

    expect(mockExpired.has(expiredId)).toBe(true);
    expect(mockMarkers.get(paymentId)).toBe(key);
    expect(mockMarkerPaise.get(paymentId)).toBeNull();
    expect(mockMarkerAttempts.get(paymentId)).toBe(3);
    expect(mockDrive).not.toHaveBeenCalled();
  },
);

it.each(expiryArms)(
  "holds $arm when an existing marker only covers a partial amount",
  async ({ prepare, expiredId, paymentId }) => {
    prepare();
    const key = "other-door:partial";
    const reason = "owner's partial-refund reason";
    mockMarkers.set(paymentId, key);
    mockMarkerPaise.set(paymentId, 500);
    mockMarkerReasons.set(paymentId, reason);
    mockMarkerAttempts.set(paymentId, 1);

    await expireStaleRequests({ limits: { maxRequests: 1 } });

    expect(mockExpired.has(expiredId)).toBe(false);
    expect(mockMarkers.get(paymentId)).toBe(key);
    expect(mockMarkerPaise.get(paymentId)).toBe(500);
    expect(mockMarkerReasons.get(paymentId)).toBe(reason);
    expect(mockMarkerAttempts.get(paymentId)).toBe(1);
    expect(mockDrive).not.toHaveBeenCalled();
  },
);

it.each(expiryArms)(
  "holds $arm with a partial marker and continues to the next request",
  async ({ arm, entityId, expiredId, paymentId, prepare }) => {
    prepare();
    const laterId =
      arm === "pending consultation" ? "consult-later" : "approved-later";
    const laterExpiredId =
      arm === "pending consultation" ? `consultation:${laterId}` : laterId;
    const laterPaymentId = `pay-${laterId}`;
    if (arm === "pending consultation") {
      mockPendingConsultations = [entityId, laterId];
    } else {
      mockApprovedUnallocated = [entityId, laterId];
    }
    mockDue.set(laterId, [laterPaymentId]);
    const key = "other-door:partial-at-retry-limit";
    const reason = "owner's partial-refund reason";
    mockMarkers.set(paymentId, key);
    mockMarkerPaise.set(paymentId, 500);
    mockMarkerReasons.set(paymentId, reason);
    mockMarkerAttempts.set(paymentId, 3);

    const result = await expireStaleRequests({ limits: { maxRequests: 1 } });

    expect(result.success).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          arm === "pending consultation"
            ? "Pending consultation expiry held by a partial refund marker"
            : "Approved-unallocated expiry held by a partial refund marker",
        ),
      ]),
    );
    expect(mockExpired.has(expiredId)).toBe(false);
    expect(mockMarkers.get(paymentId)).toBe(key);
    expect(mockMarkerPaise.get(paymentId)).toBe(500);
    expect(mockMarkerReasons.get(paymentId)).toBe(reason);
    expect(mockMarkerAttempts.get(paymentId)).toBe(3);
    expect(mockExpired.has(laterExpiredId)).toBe(true);
    expect(mockHistory).toEqual([laterId]);
    expect(mockMarkers.get(laterPaymentId)).toBe(
      arm === "pending consultation"
        ? `pending-consultation:${laterPaymentId}`
        : `approved-unallocated:${laterPaymentId}`,
    );
    expect(mockDrive).toHaveBeenCalledTimes(1);
    expect(mockDrive).toHaveBeenCalledWith(
      expect.objectContaining({ paymentId: laterPaymentId, amountPaise: null }),
    );
    expect(mockExpiredNotice).toHaveBeenCalledTimes(1);
    expect(mockExpiredNotice).toHaveBeenCalledWith(
      expect.objectContaining({ appointmentId: `a-${laterId}` }),
    );
  },
);

it.each(expiryArms)(
  "reports a hold when a partial marker arrives before $arm candidate selection",
  async ({ arm, prepare, expiredId, paymentId }) => {
    prepare();
    const installMarker = () => {
      mockMarkers.set(paymentId, "other-door:concurrent-partial");
      mockMarkerPaise.set(paymentId, 500);
      mockMarkerAttempts.set(paymentId, 3);
    };
    if (arm === "pending consultation") {
      mockBeforeConsultationCohortRead = installMarker;
    } else {
      mockBeforeApprovedCohortRead = installMarker;
    }

    const result = await expireStaleRequests({ limits: { maxRequests: 1 } });

    expect(result.success).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("partial refund marker"),
      ]),
    );
    expect(mockExpired.has(expiredId)).toBe(false);
    expect(mockHistory).toEqual([]);
    expect(mockMarkers.get(paymentId)).toBe("other-door:concurrent-partial");
    expect(mockMarkerPaise.get(paymentId)).toBe(500);
    expect(mockMarkerAttempts.get(paymentId)).toBe(3);
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

it("leaves preexisting approved-expiry rows unmarked and undriven", async () => {
  mockLegacyApproved = ["old-approved-pay-1", "old-approved-pay-2"];
  mockFresh = [];
  mockDue.clear();

  await expireStaleRequests({ limits: { maxRequests: 1 } });
  await expireStaleRequests({ limits: { maxRequests: 1 } });

  expect(mockMarkers.size).toBe(0);
  expect(mockExpired.size).toBe(0);
  expect(mockHistory).toEqual([]);
  expect(prisma.$executeRaw).not.toHaveBeenCalled();
  expect(mockDrive).not.toHaveBeenCalled();
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

it("shares the deadline across current transitions and inline delivery", async () => {
  mockFresh = ["sub-1", "sub-2"];
  mockDue.set("sub-2", ["pay-2"]);
  mockDrive.mockImplementation(async () => {
    mockNow += 16_000;
    return { kind: "settled" };
  });
  const result = await expireStaleRequests({ limits: { maxRequests: 2 } });
  expect(mockDrive).toHaveBeenCalledTimes(1);
  expect(mockMarkers.size).toBe(2);
  expect(result.unallocatedRefundsDeferred).toBe(1);
});

it("does not stage or drive old unallocated-expiry rows on repeated ticks", async () => {
  mockFresh = [];
  mockLegacy = ["a", "b", "c"];
  const first = await expireStaleRequests({ limits: { maxRequests: 2 } });
  await expireStaleRequests({ limits: { maxRequests: 2 } });
  expect(first.unallocatedHasMore).toBe(false);
  expect(mockMarkers.size).toBe(0);
  expect(prisma.$executeRaw).not.toHaveBeenCalled();
  expect(mockDrive).not.toHaveBeenCalled();
});

it("does not stamp an old unmarked expiry through the single-plan admin door", async () => {
  mockFresh = [];
  mockLegacy = ["old-unmarked"];
  const result = await expireUnallocatedPaidSubscriptionForOne("sub-1");
  expect(result.expired).toBe(false);
  expect(mockMarkers.size).toBe(0);
  expect(prisma.$executeRaw).not.toHaveBeenCalled();
  expect(mockDrive).not.toHaveBeenCalled();
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
