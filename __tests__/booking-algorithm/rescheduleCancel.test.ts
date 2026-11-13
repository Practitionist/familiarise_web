/**
 * @jest-environment node
 */

/**
 * Comprehensive tests for Reschedule, Cancel, and Cleanup functionality
 *
 * Covers:
 * - RescheduleErrors: custom error class behavior and message formatting
 * - CancelAppointmentSchema: Zod validation for cancellation input
 * - Reschedule API route: authentication, 24-hour policy, slot marking, status updates
 * - Cancel API route: authentication, cancellation data, slot/appointment deletion, notifications
 * - Cleanup tentative slots: stale slot detection, deletion, and error handling
 *
 * Uses node environment (not jsdom) because route handlers import next/server
 * which requires the Web API Request/Response globals.
 */

// ─── Module Mocks ───────────────────────────────────────────────────────────

// Mock prisma (relative path required — @/ aliases fail in jest.mock)
jest.mock("next/headers", () => ({ headers: async () => new Headers() }));
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    $transaction: jest.fn(),
    // #1006 — cancel resolves the refund facts across the WHOLE booking, so it
    // reads every appointment of the parent request, not just the one it was
    // handed. Default to none: the refund path is exercised in its own suites.
    appointment: {
      findUnique: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      // #1554 — the refund context reads the one wrapper; none here.
      findFirst: jest.fn().mockResolvedValue(null),
    },
    // #1003 — group-event cancel reads the attendee roster off the payments so
    // it can notify them. Default to an empty event.
    payment: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    // #1780 R-3 — free seats are read off the participant rows as well.
    appointmentParticipant: { findMany: jest.fn().mockResolvedValue([]) },
    // #1580 C-P1-5 — group-event cancel and reschedule read the ACCEPTED
    // collaborators for the recipient list. Default to none.
    collaborator: { findMany: jest.fn().mockResolvedValue([]) },
    appointmentOccurrence: {
      findMany: jest.fn(),
      updateManyAndReturn: jest.fn().mockResolvedValue([]),
    },
    bookingStatusHistory: { create: jest.fn().mockResolvedValue({}) },
    // #1008 — the cancel/reschedule routes call hasActiveDisputeForAppointment,
    // which reads prisma.dispute.findFirst. Default to no live dispute.
    dispute: { findFirst: jest.fn().mockResolvedValue(null) },
    // A repeated cancel reads back what the first click committed.
    consultation: { findUnique: jest.fn().mockResolvedValue(null) },
    // The Idempotency-Key store, in memory: the unique index answers P2002.
    idempotencyRecord: (() => {
      const rows = new Map<string, Record<string, unknown>>();
      const keyOf = (w: {
        scope_key_userId: { scope: string; key: string; userId: string };
      }) =>
        `${w.scope_key_userId.scope}|${w.scope_key_userId.key}|${w.scope_key_userId.userId}`;
      return {
        rows,
        create: jest.fn(async ({ data }: { data: Record<string, string> }) => {
          const k = `${data.scope}|${data.key}|${data.userId}`;
          if (rows.has(k))
            throw Object.assign(new Error("dup"), { code: "P2002" });
          rows.set(k, { ...data, completedAt: null });
          return rows.get(k);
        }),
        findUnique: jest.fn(
          async ({ where }: { where: Parameters<typeof keyOf>[0] }) =>
            rows.get(keyOf(where)) ?? null,
        ),
        update: jest.fn(
          async ({
            where,
            data,
          }: {
            where: Parameters<typeof keyOf>[0];
            data: Record<string, unknown>;
          }) => {
            const k = keyOf(where);
            rows.set(k, { ...rows.get(k), ...data });
            return rows.get(k);
          },
        ),
        delete: jest.fn(
          async ({ where }: { where: Parameters<typeof keyOf>[0] }) => {
            rows.delete(keyOf(where));
            return {};
          },
        ),
      };
    })(),
    $disconnect: jest.fn(),
  },
}));

// The sweep's lease is covered by the with-cron-lock suite; run the core unlocked here.
jest.mock("../../lib/cron/with-cron-lock", () => ({
  withCronLock: (_job: string, _opts: unknown, fn: () => unknown) => fn(),
}));

// Mock auth-server (better-auth)
jest.mock("../../lib/rate-limit", () => ({
  __esModule: true,
  applyRateLimit: jest.fn(async () => null),
  eventMutationLimiter: {},
  rescheduleAppointmentLimiter: {},
}));
jest.mock("../../utils/appointmentlock", () => ({
  __esModule: true,
  withAppointmentLock: jest.fn(
    async (_id: string, fn: () => Promise<unknown>) => fn(),
  ),
  withEventCheckoutLock: jest.fn(
    async (_key: unknown, fn: () => Promise<unknown>) => fn(),
  ),
  BookingLockUnavailableError: class extends Error {},
  AppointmentBusyError: class extends Error {},
}));
jest.mock("../../lib/auth-server", () => ({
  getSession: jest.fn(),
}));

// Mock novu notifications
jest.mock("../../lib/novu", () => ({
  notifyAppointmentCancelled: jest.fn().mockResolvedValue(undefined),
}));

// #776 §C — whole-event (class/webinar) cancel refunds are exercised in their
// own suite; here the cancel route just needs a benign summary back.
jest.mock("../../lib/payments/operations/event-refunds", () => ({
  // #1780 D-5 — the per-seat ledgers read before the cancel transaction.
  classSeriesLedgers: jest.fn().mockResolvedValue(new Map()),
  stampWholeEventRefundsOwed: jest.fn().mockResolvedValue(new Map()),
  refundWholeEventPayments: jest.fn().mockResolvedValue({
    refundsIssued: 0,
    refundedPaise: 0,
    childRefundIds: [],
    failures: [],
  }),
}));

const seatGeneration = new Date("2030-01-01T00:02:00Z");
jest.mock("../../lib/stream/access-revocation", () => ({
  persistSeatRevocationInTx: jest.fn(async () => seatGeneration),
  revokeEndedSeatAccess: jest.fn().mockResolvedValue(undefined),
  fenceSeatGrants: jest.fn().mockResolvedValue({ verified: true, lost: [] }),
  enqueueCollaboratorRevocationRetry: jest.fn().mockResolvedValue(undefined),
}));

// ─── Imports ────────────────────────────────────────────────────────────────

import type { NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import { getSession } from "@/lib/auth-server";
import { notifyAppointmentCancelled } from "@/lib/novu";
import {
  persistSeatRevocationInTx,
  revokeEndedSeatAccess,
} from "@/lib/stream/access-revocation";
import { POST as rescheduleHandler } from "@/app/api/appointments/[appointmentId]/reschedule/route";
import { POST as cancelHandler } from "@/app/api/appointments/[appointmentId]/cancel/route";
import {
  ReschedulePolicyError,
  AppointmentNotFoundError,
} from "@/utils/errors/RescheduleErrors";
import { CancelAppointmentSchema } from "@/schemas/appointments";
import { cleanupTentativeOccurrences } from "../../scripts/appointments/cleanup-tentative-occurrences";

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Create a Request for the reschedule endpoint */
function makeRescheduleRequest(
  appointmentId: string,
  type: string,
  body?: Record<string, unknown>,
) {
  const url = `http://localhost/api/appointments/${appointmentId}/reschedule?type=${type}`;
  return new Request(url, {
    method: "POST",
    ...(body
      ? {
          body: JSON.stringify(body),
          headers: { "Content-Type": "application/json" },
        }
      : {}),
  }) as unknown as NextRequest;
}

/** Create a Request for the cancel endpoint */
function makeCancelRequest(
  appointmentId: string,
  body?: Record<string, unknown>,
) {
  const url = `http://localhost/api/appointments/${appointmentId}/cancel`;
  return new Request(url, {
    method: "POST",
    ...(body
      ? {
          body: JSON.stringify(body),
          headers: { "Content-Type": "application/json" },
        }
      : {}),
  }) as unknown as NextRequest;
}

/** Create params promise (Next.js 15 async params pattern) */
function makeParams(appointmentId: string) {
  return { params: Promise.resolve({ appointmentId }) };
}

// ─── Time Constants ─────────────────────────────────────────────────────────

const FUTURE_DATE = new Date(Date.now() + 48 * 60 * 60 * 1000); // 48h ahead
const NEAR_DATE = new Date(Date.now() + 12 * 60 * 60 * 1000); // 12h ahead

// ─── Slot & Appointment Factories ───────────────────────────────────────────

function makeSlot(
  id: string,
  startsAt: Date,
  overrides: Record<string, unknown> = {},
) {
  return {
    ordinal: 1,
    id,
    startsAt,
    endsAt: new Date(startsAt.getTime() + 30 * 60 * 1000),
    isTentative: false,
    // `@default(SCHEDULED)`, non-nullable. Whole-series flows filter on
    // SLOT_RESCHEDULABLE_FROM so a delivered session cannot brick the
    // aggregate 24h gate; an unset fixture reads as not-live.
    completionStatus: "SCHEDULED",
    appointmentId: "apt-1",
    createdAt: new Date("2025-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

function makeConsultationAppointment(overrides: Record<string, unknown> = {}) {
  return {
    id: "apt-1",
    appointmentType: "CONSULTATION",
    occurrences: [
      makeSlot("slot-1", FUTURE_DATE),
      makeSlot("slot-2", new Date(FUTURE_DATE.getTime() + 30 * 60 * 1000)),
    ],
    consultation: {
      id: "cons-1",
      status: "APPROVED",
      requestedById: "ce-1",
      consultationPlan: {
        title: "Test Plan",
        consultantProfileId: "cp-1",
        consultantProfile: {
          user: { id: "consultant-1", name: "Dr. Smith" },
        },
      },
      requestedBy: {
        user: { id: "user-1", name: "John Doe" },
      },
    },
    subscription: null,
    webinar: null,
    class: null,
    ...overrides,
  };
}

function makeSubscriptionAppointment(overrides: Record<string, unknown> = {}) {
  return {
    id: "apt-1",
    appointmentType: "SUBSCRIPTION",
    occurrences: [
      makeSlot("slot-1", FUTURE_DATE),
      makeSlot("slot-2", new Date(FUTURE_DATE.getTime() + 30 * 60 * 1000)),
    ],
    consultation: null,
    subscription: {
      id: "sub-1",
      status: "APPROVED",
      requestedById: "ce-1",
      subscriptionPlan: {
        title: "Monthly Plan",
        consultantProfileId: "cp-1",
        consultantProfile: {
          user: { id: "consultant-1", name: "Dr. Smith" },
        },
      },
      requestedBy: {
        user: { id: "user-1", name: "John Doe" },
      },
    },
    webinar: null,
    class: null,
    ...overrides,
  };
}

function makeWebinarAppointment(overrides: Record<string, unknown> = {}) {
  return {
    id: "apt-1",
    appointmentType: "WEBINAR",
    occurrences: [makeSlot("slot-1", FUTURE_DATE)],
    consultation: null,
    subscription: null,
    webinar: {
      id: "web-1",
      status: "SCHEDULED",
      webinarPlan: { consultantProfileId: "cp-1" },
    },
    class: null,
    ...overrides,
  };
}

function makeClassAppointment(overrides: Record<string, unknown> = {}) {
  return {
    id: "apt-1",
    appointmentType: "CLASS",
    occurrences: [makeSlot("slot-1", FUTURE_DATE)],
    consultation: null,
    subscription: null,
    webinar: null,
    class: {
      id: "cls-1",
      status: "SCHEDULED",
      classPlan: { consultantProfileId: "cp-1" },
    },
    ...overrides,
  };
}

// ─── Mock Transaction Factory ───────────────────────────────────────────────

function makeMockTx() {
  return {
    appointment: {
      findUnique: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      // #1695 — the refund context is read on the tx client, under the lock.
      findFirst: jest.fn().mockResolvedValue(null),
      delete: jest.fn(),
      deleteMany: jest.fn(),
    },
    consultation: {
      update: jest.fn(),
      findUnique: jest.fn().mockResolvedValue({ status: "SCHEDULED" }),
      // B2 — the cancel/reschedule CAS guards use updateMany.
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    subscription: {
      update: jest.fn(),
      findUnique: jest.fn().mockResolvedValue({ status: "SCHEDULED" }),
      // B2 — the cancel/reschedule CAS guards use updateMany.
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      // #448 / #1583 A-P0-03 — a PARTIAL (slotIds) subscription reschedule
      // terminal-guards through a locking updateMany touch (no status write);
      // the shared updateMany mock above answers count: 1 for it.
    },
    webinar: {
      update: jest.fn(),
      findUnique: jest.fn().mockResolvedValue({ status: "SCHEDULED" }),
      // B2 — the cancel/reschedule CAS guards use updateMany.
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    class: {
      update: jest.fn(),
      findUnique: jest.fn().mockResolvedValue({ status: "SCHEDULED" }),
      // B2 — the cancel/reschedule CAS guards use updateMany.
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    // transitionOccurrenceCompletion reads the from-status, then moves the cohort
    // with updateManyAndReturn so each moved id gets its history row.
    appointmentOccurrence: {
      findMany: jest.fn().mockResolvedValue([]),
      updateManyAndReturn: jest.fn().mockResolvedValue([{ id: "slot-1" }]),
      deleteMany: jest.fn(),
    },
    // The cancel expires the booking's live payments in its own commit.
    payment: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    appointmentParticipant: {
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      // An event cancel reads back the seats its sweep released.
      updateManyAndReturn: jest.fn().mockResolvedValue([]),
    },
    bookingStatusHistory: {
      create: jest.fn().mockResolvedValue({}),
      // The reschedule caps count past release acts.
      groupBy: jest.fn().mockResolvedValue([]),
    },
    // Cancel closes any live reschedule proposal so the appointment's
    // openForAppointmentId reservation is released and the expiry cron cannot
    // act on a cancelled booking. Reschedule creates one when times are proposed.
    rescheduleRequest: {
      findFirst: jest.fn().mockResolvedValue(null),
      // The cancel route reads the open proposals, then CASes each by id.
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue({ status: "PENDING_REVIEW" }),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      create: jest.fn().mockResolvedValue({ id: "reschedule-request-1" }),
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// RescheduleErrors
// ═══════════════════════════════════════════════════════════════════════════════

describe("RescheduleErrors", () => {
  describe("ReschedulePolicyError", () => {
    it("should format message with minimum hours required", () => {
      const err = new ReschedulePolicyError(12.7, 24);
      expect(err.message).toContain("24 hours");
      expect(err.name).toBe("ReschedulePolicyError");
    });

    it("should floor hoursUntilSlot in message", () => {
      const err = new ReschedulePolicyError(5.99, 24);
      expect(err.message).toContain("5 hours");
    });

    it("should clamp negative hours to 0", () => {
      const err = new ReschedulePolicyError(-2, 24);
      expect(err.message).toContain("0 hours");
    });

    it("should expose hoursUntilSlot and minimumHoursRequired properties", () => {
      const err = new ReschedulePolicyError(10.5, 24);
      expect(err.hoursUntilSlot).toBe(10.5);
      expect(err.minimumHoursRequired).toBe(24);
    });

    it("should be instanceof Error", () => {
      const err = new ReschedulePolicyError(10, 24);
      expect(err).toBeInstanceOf(Error);
    });

    it("should have correct name for instanceof checks", () => {
      const err = new ReschedulePolicyError(10, 24);
      expect(err instanceof ReschedulePolicyError).toBe(true);
    });
  });

  describe("AppointmentNotFoundError", () => {
    it("should show 'Appointment not found' for appointment type", () => {
      const err = new AppointmentNotFoundError("appointment", "apt-123");
      expect(err.message).toBe("Appointment not found");
      expect(err.name).toBe("AppointmentNotFoundError");
    });

    it("should show slot message for slot type", () => {
      const err = new AppointmentNotFoundError("slot", "slot-456");
      expect(err.message).toBe("Specified slot not found in this appointment");
    });

    it("should expose resourceType and resourceId", () => {
      const err = new AppointmentNotFoundError("appointment", "apt-789");
      expect(err.resourceType).toBe("appointment");
      expect(err.resourceId).toBe("apt-789");
    });

    it("should handle composite slot IDs (comma-separated)", () => {
      const err = new AppointmentNotFoundError(
        "slot",
        "slot-1, slot-2, slot-3",
      );
      expect(err.resourceId).toBe("slot-1, slot-2, slot-3");
    });

    it("should be instanceof Error", () => {
      const err = new AppointmentNotFoundError("appointment", "apt-1");
      expect(err).toBeInstanceOf(Error);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// CancelAppointmentSchema
// ═══════════════════════════════════════════════════════════════════════════════

describe("CancelAppointmentSchema", () => {
  it("should accept empty object (no reason or notes)", () => {
    const result = CancelAppointmentSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("should accept valid cancellation reason", () => {
    const result = CancelAppointmentSchema.safeParse({
      reason: "SCHEDULE_CONFLICT",
    });
    expect(result.success).toBe(true);
    expect(result.success ? result.data.reason : undefined).toBe(
      "SCHEDULE_CONFLICT",
    );
  });

  it("should accept all valid CancellationReason enum values", () => {
    const reasons = [
      "SCHEDULE_CONFLICT",
      "FOUND_ALTERNATIVE",
      "FINANCIAL_REASONS",
      "PERSONAL_EMERGENCY",
      "NO_LONGER_NEEDED",
      "CONSULTANT_UNAVAILABLE",
      "CONSULTANT_EMERGENCY",
      "PAYMENT_FAILED",
      "EXPIRED",
      "OTHER",
    ];
    for (const reason of reasons) {
      const result = CancelAppointmentSchema.safeParse({ reason });
      expect(result.success).toBe(true);
    }
  });

  it("should accept notes string", () => {
    const result = CancelAppointmentSchema.safeParse({
      notes: "Need to cancel due to scheduling conflict",
    });
    expect(result.success).toBe(true);
    expect(result.success ? result.data.notes : undefined).toBe(
      "Need to cancel due to scheduling conflict",
    );
  });

  it("should accept reason and notes together", () => {
    const result = CancelAppointmentSchema.safeParse({
      reason: "PERSONAL_EMERGENCY",
      notes: "Family emergency",
    });
    expect(result.success).toBe(true);
  });

  it("should reject invalid cancellation reason", () => {
    const result = CancelAppointmentSchema.safeParse({
      reason: "INVALID_REASON",
    });
    expect(result.success).toBe(false);
  });

  it("should reject non-string notes", () => {
    const result = CancelAppointmentSchema.safeParse({ notes: 42 });
    expect(result.success).toBe(false);
  });

  it("should accept undefined fields (both optional)", () => {
    const result = CancelAppointmentSchema.safeParse({
      reason: undefined,
      notes: undefined,
    });
    expect(result.success).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Reschedule Route Handler — POST
// ═══════════════════════════════════════════════════════════════════════════════

describe("Reschedule Route Handler - POST", () => {
  let mockTx: ReturnType<typeof makeMockTx>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockTx = makeMockTx();

    // Default: authenticated user with matching profile IDs
    (getSession as jest.Mock).mockResolvedValue({
      user: {
        id: "user-1",
        name: "John Doe",
        consulteeProfileId: "ce-1",
        consultantProfileId: "cp-1",
      },
    });

    // Default: transaction passes callback through to mock tx
    (prisma.$transaction as jest.Mock).mockImplementation(
      async (callback: (tx: typeof mockTx) => unknown) => callback(mockTx),
    );
  });

  // ─── Authentication ─────────────────────────────────────────────────────

  it("should return 401 when not authenticated", async () => {
    (getSession as jest.Mock).mockResolvedValue(null);

    const req = makeRescheduleRequest("apt-1", "CONSULTATION");
    const res = await rescheduleHandler(req, makeParams("apt-1"));
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.error).toBe("Unauthorized");
  });

  it("should return 401 when session has no user", async () => {
    (getSession as jest.Mock).mockResolvedValue({ user: null });

    const req = makeRescheduleRequest("apt-1", "CONSULTATION");
    const res = await rescheduleHandler(req, makeParams("apt-1"));

    expect(res.status).toBe(401);
  });

  // ─── Appointment Not Found ──────────────────────────────────────────────

  it("should return 404 when appointment not found", async () => {
    mockTx.appointment.findUnique.mockResolvedValue(null);

    const req = makeRescheduleRequest("nonexistent", "CONSULTATION");
    const res = await rescheduleHandler(req, makeParams("nonexistent"));
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error).toContain("not found");
  });

  // ─── 24-Hour Restriction ───────────────────────────────────────────────

  it("should return 400 when slot is within 24 hours", async () => {
    const appointment = makeConsultationAppointment({
      occurrences: [makeSlot("slot-1", NEAR_DATE)],
    });
    mockTx.appointment.findUnique.mockResolvedValue(appointment);

    const req = makeRescheduleRequest("apt-1", "CONSULTATION");
    const res = await rescheduleHandler(req, makeParams("apt-1"));
    const body = await res.json();

    // A typed refusal: 409 RESCHEDULE_WINDOW, the sentence the toast shows.
    expect(res.status).toBe(409);
    expect(body.code).toBe("RESCHEDULE_WINDOW");
    expect(body.error).toContain("24 hours");
  });

  it("refuses a session exactly 24 hours away: isTooSoonFor draws the one boundary", async () => {
    // Only the clock is frozen; timers and microtasks run for real.
    jest.useFakeTimers({
      doNotFake: [
        "nextTick",
        "setImmediate",
        "setTimeout",
        "clearTimeout",
        "setInterval",
        "clearInterval",
        "queueMicrotask",
      ],
    });
    const now = Date.now();
    jest.setSystemTime(now);
    try {
      const appointment = makeConsultationAppointment({
        occurrences: [makeSlot("slot-1", new Date(now + 24 * 60 * 60 * 1000))],
      });
      mockTx.appointment.findUnique.mockResolvedValue(appointment);

      const req = makeRescheduleRequest("apt-1", "CONSULTATION");
      const res = await rescheduleHandler(req, makeParams("apt-1"));

      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe("RESCHEDULE_WINDOW");
    } finally {
      jest.useRealTimers();
    }
  });

  it("should enforce 24-hour restriction even if only one of multiple slots is near", async () => {
    const appointment = makeSubscriptionAppointment({
      occurrences: [
        makeSlot("slot-1", FUTURE_DATE), // 48h ahead — OK
        makeSlot("slot-2", NEAR_DATE), // 12h ahead — too close
      ],
    });
    mockTx.appointment.findUnique.mockResolvedValue(appointment);

    const req = makeRescheduleRequest("apt-1", "SUBSCRIPTION", {
      slotIds: ["slot-1", "slot-2"],
    });
    const res = await rescheduleHandler(req, makeParams("apt-1"));

    expect(res.status).toBe(409);
  });

  // ─── CONSULTATION Reschedule ────────────────────────────────────────────

  describe("CONSULTATION", () => {
    it("should mark all slots as tentative and update status to PENDING", async () => {
      const appointment = makeConsultationAppointment();
      mockTx.appointment.findUnique.mockResolvedValue(appointment);

      const req = makeRescheduleRequest("apt-1", "CONSULTATION");
      const res = await rescheduleHandler(req, makeParams("apt-1"));
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.rescheduleType).toBe("entire_booking");
      expect(body.slotsAffected).toBe(2);

      // Verify slots marked tentative by appointmentId (non-subscription path)
      expect(
        mockTx.appointmentOccurrence.updateManyAndReturn,
      ).toHaveBeenCalledWith(
        // objectContaining: `select` is the helper's own business.
        expect.objectContaining({
          where: {
            appointmentId: "apt-1",
            // #837 — reschedule never resurrects COMPLETED/CANCELLED history
            completionStatus: { in: ["SCHEDULED"] },
          },
          data: { isTentative: true, completionStatus: "RESCHEDULED" },
        }),
      );

      // Verify consultation status reverted
      expect(mockTx.consultation.updateMany).toHaveBeenCalledWith({
        where: {
          id: "cons-1",
          status: { in: ["APPROVED"] },
        },
        // E2E-audit P0 — the PENDING flip MUST refresh requestedAt. The
        // stale-request expiry sweep keys its PENDING cohort on that column,
        // so a reschedule that left the original timestamp made any booking
        // older than 48h read as stale: the next hourly run EXPIRED and fully
        // refunded a live booking whose proposal was still open.
        data: { status: "PENDING", requestedAt: expect.any(Date) },
      });
    });
  });

  // ─── Reschedule caps (counted from the release history) ─────────────────

  describe("caps", () => {
    /** Requests on the side that moved session 1 (released, never restored). */
    const moves = (n: number, status = "ACCEPTED") =>
      Array.from({ length: n }, (_, i) => ({
        id: `req-${i}`,
        status,
        createdAt: new Date(Date.UTC(2026, 9, 1 + i)),
        releasedSessions: [{ ordinal: 1, startsAt: FUTURE_DATE.toISOString() }],
        releasedOccurrenceIds: [`gone-${i}`],
      }));

    it("refuses an expert's third reschedule, proposal or not", async () => {
      (getSession as jest.Mock).mockResolvedValue({
        user: { id: "consultant-1", consultantProfileId: "cp-1" },
      });
      mockTx.appointment.findUnique.mockResolvedValue(
        makeConsultationAppointment(),
      );
      mockTx.rescheduleRequest.findMany.mockResolvedValue(moves(2));

      const res = await rescheduleHandler(
        makeRescheduleRequest("apt-1", "CONSULTATION"),
        makeParams("apt-1"),
      );

      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe("EXPERT_RESCHEDULE_CAP");
      expect(mockTx.rescheduleRequest.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            appointmentId: "apt-1",
            initiatorRole: "CONSULTANT",
            status: { not: "WITHDRAWN" },
          }),
        }),
      );
    });

    it("holds the consultee cap per session across accept → reschedule again (replaced rows are gone)", async () => {
      mockTx.appointment.findUnique.mockResolvedValue(
        makeConsultationAppointment({
          occurrences: [makeSlot("slot-3", FUTURE_DATE)],
        }),
      );
      mockTx.rescheduleRequest.findMany.mockResolvedValue(moves(2));

      const res = await rescheduleHandler(
        makeRescheduleRequest("apt-1", "CONSULTATION"),
        makeParams("apt-1"),
      );

      expect(res.status).toBe(422);
      expect((await res.json()).code).toBe("MAX_RESCHEDULES_EXCEEDED");
    });

    it("does not charge a request whose ending put the booking back", async () => {
      mockTx.appointment.findUnique.mockResolvedValue(
        makeConsultationAppointment({
          occurrences: [makeSlot("slot-3", FUTURE_DATE)],
        }),
      );
      // The database answers only unrestored requests.
      mockTx.rescheduleRequest.findMany.mockResolvedValue([]);

      const res = await rescheduleHandler(
        makeRescheduleRequest("apt-1", "CONSULTATION"),
        makeParams("apt-1"),
      );

      expect(res.status).toBe(200);
      expect(mockTx.rescheduleRequest.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ restoredAt: null }),
        }),
      );
    });
  });

  // ─── SUBSCRIPTION Reschedule ────────────────────────────────────────────

  describe("SUBSCRIPTION", () => {
    it("should mark ALL subscription slots tentative when no slotIds provided", async () => {
      // #1554 — the subscription is ONE wrapper; every session is a row on it.
      const appointment = makeSubscriptionAppointment();
      mockTx.appointment.findUnique.mockResolvedValue(appointment);

      const req = makeRescheduleRequest("apt-1", "SUBSCRIPTION");
      const res = await rescheduleHandler(req, makeParams("apt-1"));
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.rescheduleType).toBe("entire_booking");

      // Should mark every live row of the one wrapper tentative
      expect(
        mockTx.appointmentOccurrence.updateManyAndReturn,
      ).toHaveBeenCalledWith(
        // objectContaining: `select` is the helper's own business.
        expect.objectContaining({
          where: {
            appointmentId: "apt-1",
            completionStatus: { in: ["SCHEDULED"] },
          },
          data: { isTentative: true, completionStatus: "RESCHEDULED" },
        }),
      );

      // Should update subscription status
      expect(mockTx.subscription.updateMany).toHaveBeenCalledWith({
        where: {
          id: "sub-1",
          status: { in: ["APPROVED"] },
        },
        // E2E-audit P0 — the PENDING flip MUST refresh requestedAt. The
        // stale-request expiry sweep keys its PENDING cohort on that column,
        // so a reschedule that left the original timestamp made any booking
        // older than 48h read as stale: the next hourly run EXPIRED and fully
        // refunded a live booking whose proposal was still open.
        data: { status: "PENDING", requestedAt: expect.any(Date) },
      });
    });

    it("should mark only specified slots when slotIds provided (individual)", async () => {
      const appointment = makeSubscriptionAppointment();
      mockTx.appointment.findUnique.mockResolvedValue(appointment);

      const req = makeRescheduleRequest("apt-1", "SUBSCRIPTION", {
        slotIds: ["slot-1"],
      });
      const res = await rescheduleHandler(req, makeParams("apt-1"));
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.rescheduleType).toBe("individual_session");
      expect(body.slotsAffected).toBe(1);

      // #1554 — one row is one session, so exactly the named rows are
      // released; releasing by appointment would free the whole programme.
      expect(
        mockTx.appointmentOccurrence.updateManyAndReturn,
      ).toHaveBeenCalledWith(
        // objectContaining: `select` is the helper's own business.
        expect.objectContaining({
          where: {
            appointmentId: "apt-1",
            id: { in: ["slot-1"] },
            completionStatus: { in: ["SCHEDULED"] },
          },
          data: { isTentative: true, completionStatus: "RESCHEDULED" },
        }),
      );
    });

    it("should return 'multiple_sessions' type when slotIds span multiple sessions", async () => {
      const appointment = makeSubscriptionAppointment();
      mockTx.appointment.findUnique.mockResolvedValue(appointment);

      // #448 / #1554 — multiple_sessions means several occurrence rows: each
      // row is one session of the one wrapper.
      const req = makeRescheduleRequest("apt-1", "SUBSCRIPTION", {
        slotIds: ["slot-1", "slot-2"],
      });
      const res = await rescheduleHandler(req, makeParams("apt-1"));
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.rescheduleType).toBe("multiple_sessions");
      expect(body.sessionsAffected).toBe(2);
      expect(body.slotsAffected).toBe(2);
    });

    it("answers 409 when the partial path's locking touch matches no live parent", async () => {
      // #1583 A-P0-03 — the touch is an updateMany so the row lock is held
      // to commit; a zero count means a sweep terminalised the parent first.
      const appointment = makeSubscriptionAppointment();
      mockTx.appointment.findUnique.mockResolvedValue(appointment);
      mockTx.subscription.updateMany.mockResolvedValueOnce({ count: 0 });

      const req = makeRescheduleRequest("apt-1", "SUBSCRIPTION", {
        slotIds: ["slot-1"],
      });
      const res = await rescheduleHandler(req, makeParams("apt-1"));

      expect(res.status).toBe(409);
      expect(mockTx.subscription.updateMany).toHaveBeenCalledWith({
        where: { id: "sub-1", status: "APPROVED" },
        data: { updatedAt: expect.any(Date) },
      });
    });

    it("should return 404 when requested slotIds not found in subscription", async () => {
      const appointment = makeSubscriptionAppointment();
      mockTx.appointment.findUnique.mockResolvedValue(appointment);

      const req = makeRescheduleRequest("apt-1", "SUBSCRIPTION", {
        slotIds: ["slot-1", "nonexistent-slot"],
      });
      const res = await rescheduleHandler(req, makeParams("apt-1"));
      const body = await res.json();

      expect(res.status).toBe(404);
      expect(body.error).toContain("not found");
    });

    it("should support legacy single slotId parameter", async () => {
      const appointment = makeSubscriptionAppointment();
      mockTx.appointment.findUnique.mockResolvedValue(appointment);

      const req = makeRescheduleRequest("apt-1", "SUBSCRIPTION", {
        slotId: "slot-1", // legacy single slotId (not array)
      });
      const res = await rescheduleHandler(req, makeParams("apt-1"));
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.rescheduleType).toBe("individual_session");
      expect(body.slotsAffected).toBe(1);
    });
  });

  // ─── WEBINAR Reschedule ─────────────────────────────────────────────────

  describe("WEBINAR", () => {
    it("refuses a webinar release: webinars re-time instead", async () => {
      const appointment = makeWebinarAppointment();
      mockTx.appointment.findUnique.mockResolvedValue(appointment);

      const req = makeRescheduleRequest("apt-1", "WEBINAR");
      const res = await rescheduleHandler(req, makeParams("apt-1"));
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.code).toBe("USE_RETIME");
    });
  });

  // ─── CLASS Reschedule ───────────────────────────────────────────────────

  describe("CLASS", () => {
    it("refuses a class release: class sessions cancel + make-up instead", async () => {
      const appointment = makeClassAppointment();
      mockTx.appointment.findUnique.mockResolvedValue(appointment);

      const req = makeRescheduleRequest("apt-1", "CLASS");
      const res = await rescheduleHandler(req, makeParams("apt-1"));
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.code).toBe("USE_SESSION_CANCEL");
    });
  });

  // ─── Response Messages ──────────────────────────────────────────────────

  it("should return 'All sessions marked' message for entire_booking", async () => {
    mockTx.appointment.findUnique.mockResolvedValue(
      makeConsultationAppointment(),
    );

    const req = makeRescheduleRequest("apt-1", "CONSULTATION");
    const res = await rescheduleHandler(req, makeParams("apt-1"));
    const body = await res.json();

    expect(body.message).toContain("All sessions marked for rescheduling");
  });

  it("should return session(s) message for partial reschedule", async () => {
    const appointment = makeSubscriptionAppointment();
    mockTx.appointment.findUnique.mockResolvedValue(appointment);

    const req = makeRescheduleRequest("apt-1", "SUBSCRIPTION", {
      slotIds: ["slot-1"],
    });
    const res = await rescheduleHandler(req, makeParams("apt-1"));
    const body = await res.json();

    expect(body.message).toContain("session(s) marked for rescheduling");
  });

  // ─── Edge Cases ─────────────────────────────────────────────────────────

  it("replays the committed answer for a repeated Idempotency-Key instead of releasing again", async () => {
    mockTx.appointment.findUnique.mockResolvedValue(
      makeConsultationAppointment(),
    );
    const send = () =>
      rescheduleHandler(
        new Request(
          "http://localhost/api/appointments/apt-1/reschedule?type=CONSULTATION",
          {
            method: "POST",
            body: JSON.stringify({}),
            headers: {
              "Content-Type": "application/json",
              "Idempotency-Key": "reschedule-key-0001",
            },
          },
        ) as unknown as NextRequest,
        makeParams("apt-1"),
      );

    const first = await send();
    const firstBody = await first.json();
    const releases = (prisma.$transaction as jest.Mock).mock.calls.length;
    const second = await send();

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.headers.get("Idempotent-Replay")).toBe("true");
    expect(await second.json()).toEqual(firstBody);
    expect((prisma.$transaction as jest.Mock).mock.calls.length).toBe(releases);
  });

  it("refuses a malformed session list rather than releasing the whole booking", async () => {
    mockTx.appointment.findUnique.mockResolvedValue(
      makeSubscriptionAppointment(),
    );

    const req = makeRescheduleRequest("apt-1", "SUBSCRIPTION", {
      slotIds: [42],
    });
    const res = await rescheduleHandler(req, makeParams("apt-1"));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.code).toBe("INVALID_SLOT_IDS");
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("should handle empty body gracefully", async () => {
    mockTx.appointment.findUnique.mockResolvedValue(
      makeConsultationAppointment(),
    );

    const req = new Request(
      "http://localhost/api/appointments/apt-1/reschedule?type=CONSULTATION",
      { method: "POST" },
    ) as unknown as NextRequest;
    const res = await rescheduleHandler(req, makeParams("apt-1"));

    expect(res.status).toBe(200);
  });

  it("refuses a release with no session to move", async () => {
    const appointment = makeConsultationAppointment({
      occurrences: [],
    });
    mockTx.appointment.findUnique.mockResolvedValue(appointment);
    mockTx.appointmentOccurrence.updateManyAndReturn.mockResolvedValueOnce([]);

    const req = makeRescheduleRequest("apt-1", "CONSULTATION");
    const res = await rescheduleHandler(req, makeParams("apt-1"));
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.code).toBe("NO_RESCHEDULABLE_SLOTS");
  });

  it("should return 409 NO_RESCHEDULABLE_SLOTS when booking has occurrences but zero live slots moved", async () => {
    const appointment = makeConsultationAppointment();
    mockTx.appointment.findUnique.mockResolvedValue(appointment);
    mockTx.appointmentOccurrence.updateManyAndReturn.mockResolvedValueOnce([]);

    const req = makeRescheduleRequest("apt-1", "CONSULTATION");
    const res = await rescheduleHandler(req, makeParams("apt-1"));
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.code).toBe("NO_RESCHEDULABLE_SLOTS");
  });

  it("refuses a party release of a parked session as nothing to move, not as a 24-hour window", async () => {
    const appointment = makeConsultationAppointment({
      occurrences: [
        makeSlot("slot-1", NEAR_DATE, {
          completionStatus: "RESCHEDULED",
          isTentative: true,
        }),
      ],
    });
    mockTx.appointment.findUnique.mockResolvedValue(appointment);
    mockTx.appointmentOccurrence.updateManyAndReturn.mockResolvedValueOnce([]);

    const req = makeRescheduleRequest("apt-1", "CONSULTATION");
    const res = await rescheduleHandler(req, makeParams("apt-1"));
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.code).toBe("NO_RESCHEDULABLE_SLOTS");
  });

  it("releases only SCHEDULED rows for a party, so a restore never revives a parked one", async () => {
    mockTx.appointment.findUnique.mockResolvedValue(
      makeConsultationAppointment({
        occurrences: [
          makeSlot("slot-1", FUTURE_DATE),
          makeSlot("slot-2", NEAR_DATE, {
            completionStatus: "RESCHEDULED",
            isTentative: true,
          }),
        ],
      }),
    );

    const req = makeRescheduleRequest("apt-1", "CONSULTATION");
    const res = await rescheduleHandler(req, makeParams("apt-1"));

    expect(res.status).toBe(200);
    const flip = mockTx.appointmentOccurrence.updateManyAndReturn.mock
      .calls[0][0] as { where: { completionStatus: unknown } };
    expect(flip.where.completionStatus).toEqual({ in: ["SCHEDULED"] });
  });

  it("should return 500 for unexpected errors", async () => {
    (prisma.$transaction as jest.Mock).mockRejectedValue(
      new Error("Database connection lost"),
    );

    const req = makeRescheduleRequest("apt-1", "CONSULTATION");
    const res = await rescheduleHandler(req, makeParams("apt-1"));
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).toBe("Failed to request reschedule");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Cancel Route Handler — POST
// ═══════════════════════════════════════════════════════════════════════════════

describe("Cancel Route Handler - POST", () => {
  let mockTx: ReturnType<typeof makeMockTx>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockTx = makeMockTx();

    // Default: authenticated user with matching profile IDs
    (getSession as jest.Mock).mockResolvedValue({
      user: {
        id: "user-1",
        name: "John Doe",
        consulteeProfileId: "ce-1",
        consultantProfileId: "cp-1",
      },
    });

    // Default: consultation appointment found (pre-transaction fetch)
    (prisma.appointment.findUnique as jest.Mock).mockResolvedValue(
      makeConsultationAppointment(),
    );

    // Default: transaction passes callback through
    (prisma.$transaction as jest.Mock).mockImplementation(
      async (callback: (tx: typeof mockTx) => unknown) => callback(mockTx),
    );
  });

  // ─── Authentication ─────────────────────────────────────────────────────

  it("should return 401 when not authenticated", async () => {
    (getSession as jest.Mock).mockResolvedValue(null);

    const req = makeCancelRequest("apt-1");
    const res = await cancelHandler(req, makeParams("apt-1"));
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.error).toBe("Unauthorized");
  });

  // ─── Appointment Not Found ──────────────────────────────────────────────

  it("should return 404 when appointment not found", async () => {
    (prisma.appointment.findUnique as jest.Mock).mockResolvedValue(null);

    const req = makeCancelRequest("nonexistent");
    const res = await cancelHandler(req, makeParams("nonexistent"));
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error).toBe("Appointment not found");
  });

  // ─── Body Validation ───────────────────────────────────────────────────

  it("should return 400 for invalid cancellation reason", async () => {
    const req = makeCancelRequest("apt-1", { reason: "INVALID_REASON" });
    const res = await cancelHandler(req, makeParams("apt-1"));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Validation failed");
    expect(body.details).toBeDefined();
  });

  // ─── CONSULTATION Cancellation ──────────────────────────────────────────

  describe("CONSULTATION", () => {
    it("should update consultation with cancellation data and soft-cancel slots", async () => {
      const appointment = makeConsultationAppointment();
      (prisma.appointment.findUnique as jest.Mock).mockResolvedValue(
        appointment,
      );

      const req = makeCancelRequest("apt-1", {
        reason: "SCHEDULE_CONFLICT",
        notes: "Cannot make it",
      });
      const res = await cancelHandler(req, makeParams("apt-1"));
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.cancellationReason).toBe("SCHEDULE_CONFLICT");

      // Verify consultation updated with cancellation data
      expect(mockTx.consultation.updateMany).toHaveBeenCalledWith({
        where: {
          id: "cons-1",
          status: {
            // Pinned to the status this cancel read in its own transaction.
            in: ["SCHEDULED"],
          },
        },
        data: expect.objectContaining({
          status: "CANCELLED",
          cancellationReason: "SCHEDULE_CONFLICT",
          cancellationNotes: "Cannot make it",
          cancelledBy: "user-1",
        }),
      });

      // Verify slots soft-cancelled (not hard-deleted — preserves payment
      // audit trail); only live SCHEDULED slots flip, history is never
      // re-stamped.
      expect(
        mockTx.appointmentOccurrence.updateManyAndReturn,
      ).toHaveBeenCalledWith(
        // objectContaining: `select` is the helper's own business.
        expect.objectContaining({
          // RESCHEDULED counts too: a slot released by a pending reschedule is
          // not SCHEDULED, and skipping it left non-terminal rows on a booking
          // that no longer exists. UNVERIFIED counts as well: auto-complete
          // stamps past-no-meeting sessions UNVERIFIED, and leaving them live
          // keeps a non-tombstoned row on the calendar of a dead booking.
          where: {
            appointmentId: "apt-1",
            completionStatus: {
              in: ["SCHEDULED", "RESCHEDULED", "UNVERIFIED"],
            },
          },
          // The tombstone is the other half of the soft-cancel (#676 A10).
          data: { completionStatus: "CANCELLED", deletedAt: expect.any(Date) },
        }),
      );

      // Verify appointment is NOT deleted (soft-cancel preserves records)
      expect(mockTx.appointment.delete).not.toHaveBeenCalled();
    });

    it("should soft-cancel slots via updateMany (not deleteMany)", async () => {
      const req = makeCancelRequest("apt-1");
      await cancelHandler(req, makeParams("apt-1"));

      // Soft-cancel: a completionStatus write, not deleteMany
      expect(
        mockTx.appointmentOccurrence.updateManyAndReturn,
      ).toHaveBeenCalled();
      expect(mockTx.appointmentOccurrence.deleteMany).not.toHaveBeenCalled();
      expect(mockTx.appointment.delete).not.toHaveBeenCalled();
    });
  });

  // ─── SUBSCRIPTION Cancellation ──────────────────────────────────────────

  describe("SUBSCRIPTION", () => {
    it("should update subscription with cancellation data", async () => {
      const appointment = makeSubscriptionAppointment();
      (prisma.appointment.findUnique as jest.Mock).mockResolvedValue(
        appointment,
      );

      const req = makeCancelRequest("apt-1", {
        reason: "FINANCIAL_REASONS",
      });
      const res = await cancelHandler(req, makeParams("apt-1"));

      expect(res.status).toBe(200);
      expect(mockTx.subscription.updateMany).toHaveBeenCalledWith({
        where: {
          id: "sub-1",
          status: {
            // Pinned to the status this cancel read in its own transaction.
            in: ["SCHEDULED"],
          },
          // Pinned to the removed-session count the quote was priced on.
          sessionsRefunded: 0,
        },
        data: expect.objectContaining({
          status: "CANCELLED",
          cancellationReason: "FINANCIAL_REASONS",
          cancelledBy: "user-1",
        }),
      });
    });
  });

  // ─── WEBINAR Cancellation ───────────────────────────────────────────────

  describe("WEBINAR", () => {
    it("should update webinar to CANCELLED", async () => {
      const appointment = makeWebinarAppointment();
      (prisma.appointment.findUnique as jest.Mock).mockResolvedValue(
        appointment,
      );

      const req = makeCancelRequest("apt-1");
      const res = await cancelHandler(req, makeParams("apt-1"));

      expect(res.status).toBe(200);

      expect(mockTx.webinar.updateMany).toHaveBeenCalledWith({
        where: {
          id: "web-1",
          status: { in: ["DRAFT", "SCHEDULED", "IN_PROGRESS"] },
        },
        data: { status: "CANCELLED" },
      });
    });
  });

  // ─── CLASS Cancellation ─────────────────────────────────────────────────

  describe("CLASS", () => {
    it("should update class to CANCELLED", async () => {
      const appointment = makeClassAppointment();
      (prisma.appointment.findUnique as jest.Mock).mockResolvedValue(
        appointment,
      );

      const req = makeCancelRequest("apt-1");
      const res = await cancelHandler(req, makeParams("apt-1"));

      expect(res.status).toBe(200);

      expect(mockTx.class.updateMany).toHaveBeenCalledWith({
        where: {
          id: "cls-1",
          status: { in: ["DRAFT", "SCHEDULED", "IN_PROGRESS"] },
        },
        data: { status: "CANCELLED" },
      });
    });
  });

  // ─── No Body ───────────────────────────────────────────────────────────

  it("should cancel without reason when no body provided", async () => {
    (prisma.appointment.findUnique as jest.Mock).mockResolvedValue(
      makeConsultationAppointment(),
    );

    const req = new Request("http://localhost/api/appointments/apt-1/cancel", {
      method: "POST",
    }) as unknown as NextRequest;
    const res = await cancelHandler(req, makeParams("apt-1"));

    expect(res.status).toBe(200);

    // Cancellation data should have null reason and notes
    expect(mockTx.consultation.updateMany).toHaveBeenCalledWith({
      where: {
        id: "cons-1",
        status: {
          in: ["SCHEDULED"],
        },
      },
      data: expect.objectContaining({
        status: "CANCELLED",
        cancellationReason: null,
        cancellationNotes: null,
      }),
    });
  });

  // ─── Notifications ─────────────────────────────────────────────────────

  it("should fire notification to consultant and consultee", async () => {
    (prisma.appointment.findUnique as jest.Mock).mockResolvedValue(
      makeConsultationAppointment(),
    );

    const req = makeCancelRequest("apt-1", { reason: "OTHER" });
    await cancelHandler(req, makeParams("apt-1"));

    expect(notifyAppointmentCancelled).toHaveBeenCalledWith(
      expect.arrayContaining(["consultant-1", "user-1"]),
      expect.objectContaining({
        appointmentType: "CONSULTATION",
        reason: "OTHER",
      }),
    );
  });

  // #1003 — a cancelled group event used to notify NOBODY: the recipient list
  // was only assembled for the 1:1 types, so the organiser and every paying
  // attendee learned about it by finding an empty calendar.
  it("should notify the organiser and every paid attendee of a cancelled webinar", async () => {
    (prisma.appointment.findUnique as jest.Mock).mockResolvedValue(
      makeWebinarAppointment({
        webinar: {
          id: "web-1",
          status: "SCHEDULED",
          webinarPlan: {
            title: "Intro to X",
            consultantProfileId: "cp-1",
            consultantProfile: {
              user: { id: "consultant-1", name: "Dr Who" },
            },
          },
        },
      }),
    );
    (prisma.payment.findMany as jest.Mock).mockResolvedValue([
      { userId: "attendee-1", paymentIntent: "order_1" },
      { userId: "attendee-2", paymentIntent: "order_2" },
      // Duplicate seats must not produce duplicate notifications.
      { userId: "attendee-1", paymentIntent: "order_1" },
    ]);
    // #1780 R-3 — the roster is the live seats; every payment here holds one.
    (prisma.appointmentParticipant.findMany as jest.Mock).mockResolvedValue([
      { userId: "attendee-1" },
      { userId: "attendee-2" },
    ]);

    const req = makeCancelRequest("apt-1", { reason: "OTHER" });
    await cancelHandler(req, makeParams("apt-1"));

    const [recipients, payload] = (notifyAppointmentCancelled as jest.Mock).mock
      .calls[0];
    expect(recipients).toEqual(
      expect.arrayContaining(["consultant-1", "attendee-1", "attendee-2"]),
    );
    expect(recipients).toHaveLength(3);
    expect(payload).toEqual(
      expect.objectContaining({
        appointmentType: "WEBINAR",
        planTitle: "Intro to X",
      }),
    );
  });

  it("should notify the roster of a cancelled class too", async () => {
    (prisma.appointment.findUnique as jest.Mock).mockResolvedValue(
      makeClassAppointment({
        class: {
          id: "cls-1",
          status: "SCHEDULED",
          classPlan: {
            title: "Weekly Cohort",
            consultantProfileId: "cp-1",
            consultantProfile: {
              user: { id: "consultant-1", name: "Dr Who" },
            },
          },
        },
      }),
    );
    (prisma.payment.findMany as jest.Mock).mockResolvedValue([
      { userId: "attendee-9", paymentIntent: "order_9" },
    ]);
    (prisma.appointmentParticipant.findMany as jest.Mock).mockResolvedValue([
      { userId: "attendee-9" },
    ]);

    const req = makeCancelRequest("apt-1");
    await cancelHandler(req, makeParams("apt-1"));

    expect(notifyAppointmentCancelled).toHaveBeenCalledWith(
      expect.arrayContaining(["consultant-1", "attendee-9"]),
      expect.objectContaining({ appointmentType: "CLASS" }),
    );
  });

  it("revokes the seats its own commit released, never a seat that ended earlier", async () => {
    (prisma.appointment.findUnique as jest.Mock).mockResolvedValue(
      makeClassAppointment({
        class: {
          id: "cls-1",
          status: "SCHEDULED",
          classPlan: {
            title: "Weekly Cohort",
            consultantProfileId: "cp-1",
            consultantProfile: {
              user: { id: "consultant-1", name: "Dr Who" },
            },
          },
        },
      }),
    );
    (prisma.payment.findMany as jest.Mock).mockResolvedValue([]);
    // The pre-lock roster misses a seat that landed before the commit; an earlier
    // leaver's seat is already released, so the sweep does not move it.
    (prisma.appointmentParticipant.findMany as jest.Mock).mockImplementation(
      async ({ where }: { where: { status?: { in?: string[] } } }) =>
        where.status?.in?.includes("CANCELLED")
          ? [{ userId: "attendee-9" }, { userId: "attendee-left" }]
          : [{ userId: "attendee-9" }],
    );
    mockTx.appointmentParticipant.updateManyAndReturn.mockResolvedValue([
      { userId: "attendee-9", role: "CONSULTEE" },
      { userId: "attendee-late", role: "CONSULTEE" },
      { userId: "consultant-1", role: "CONSULTANT" },
    ]);

    await cancelHandler(makeCancelRequest("apt-1"), makeParams("apt-1"));
    (prisma.appointmentParticipant.findMany as jest.Mock).mockResolvedValue([]);

    const released = ["attendee-9", "attendee-late"];
    expect(persistSeatRevocationInTx).toHaveBeenCalledTimes(1);
    expect(persistSeatRevocationInTx).toHaveBeenCalledWith(
      mockTx,
      "apt-1",
      released,
    );
    expect(revokeEndedSeatAccess).toHaveBeenCalledWith(
      "apt-1",
      released,
      seatGeneration,
    );
  });

  it("writes a 1:1 consultee's seat row in the cancel commit and settles that generation", async () => {
    const res = await cancelHandler(
      makeCancelRequest("apt-1"),
      makeParams("apt-1"),
    );

    expect(res.status).toBe(200);
    expect(persistSeatRevocationInTx).toHaveBeenCalledWith(mockTx, "apt-1", [
      "user-1",
    ]);
    expect(revokeEndedSeatAccess).toHaveBeenCalledWith(
      "apt-1",
      ["user-1"],
      seatGeneration,
    );
  });

  it("a replayed 1:1 cancel runs no transaction write and persists its consultee's row itself", async () => {
    mockTx.consultation.updateMany.mockResolvedValue({ count: 0 });
    (
      prisma as unknown as { consultation: { findUnique: jest.Mock } }
    ).consultation.findUnique.mockResolvedValueOnce({
      status: "CANCELLED",
      cancelledBy: "user-1",
      cancelledAt: new Date(),
      cancellationReason: null,
    });

    const res = await cancelHandler(
      makeCancelRequest("apt-1"),
      makeParams("apt-1"),
    );

    expect(res.status).toBe(200);
    expect((await res.json()).replayed).toBe(true);
    expect(persistSeatRevocationInTx).not.toHaveBeenCalled();
    expect(revokeEndedSeatAccess).toHaveBeenCalledWith("apt-1", ["user-1"]);
  });

  it("tells free and credit seats too, not only paid ones (#1780 R-3)", async () => {
    (prisma.appointment.findUnique as jest.Mock).mockResolvedValue(
      makeClassAppointment({
        class: {
          id: "cls-1",
          status: "SCHEDULED",
          classPlan: {
            title: "Weekly Cohort",
            consultantProfileId: "cp-1",
            consultantProfile: {
              user: { id: "consultant-1", name: "Dr Who" },
            },
          },
        },
      }),
    );
    (prisma.payment.findMany as jest.Mock).mockResolvedValue([
      { userId: "attendee-credit", paymentIntent: "free_1", amount: 0 },
    ]);
    (prisma.appointmentParticipant.findMany as jest.Mock).mockResolvedValue([
      { userId: "attendee-credit" },
      { userId: "attendee-free" },
    ]);

    await cancelHandler(makeCancelRequest("apt-1"), makeParams("apt-1"));

    expect(notifyAppointmentCancelled).toHaveBeenCalledWith(
      expect.arrayContaining(["attendee-credit", "attendee-free"]),
      expect.objectContaining({ appointmentType: "CLASS" }),
    );
  });

  // ─── Response ──────────────────────────────────────────────────────────

  it("should include cancelledAt timestamp in response", async () => {
    const req = makeCancelRequest("apt-1");
    const res = await cancelHandler(req, makeParams("apt-1"));
    const body = await res.json();

    expect(body.cancelledAt).toBeDefined();
  });

  // ─── Error Handling ─────────────────────────────────────────────────────

  it("should return 500 for unexpected database errors", async () => {
    (prisma.appointment.findUnique as jest.Mock).mockResolvedValue(
      makeConsultationAppointment(),
    );
    (prisma.$transaction as jest.Mock).mockRejectedValue(
      new Error("Transaction failed"),
    );

    const req = makeCancelRequest("apt-1");
    const res = await cancelHandler(req, makeParams("apt-1"));
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).toBe("Failed to cancel appointment");
  });

  it("should identify canceller as consultant when consultant cancels", async () => {
    // Session user is the consultant
    (getSession as jest.Mock).mockResolvedValue({
      user: {
        id: "consultant-1",
        name: "Dr. Smith",
        consultantProfileId: "cp-1",
      },
    });
    (prisma.appointment.findUnique as jest.Mock).mockResolvedValue(
      makeConsultationAppointment(),
    );

    const req = makeCancelRequest("apt-1", { reason: "CONSULTANT_EMERGENCY" });
    await cancelHandler(req, makeParams("apt-1"));

    expect(notifyAppointmentCancelled).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({
        cancelledBy: "consultant",
      }),
    );
  });

  it("should identify canceller as consultee when consultee cancels", async () => {
    // Session user is the consultee (user-1)
    (getSession as jest.Mock).mockResolvedValue({
      user: {
        id: "user-1",
        name: "John Doe",
        consulteeProfileId: "ce-1",
      },
    });
    (prisma.appointment.findUnique as jest.Mock).mockResolvedValue(
      makeConsultationAppointment(),
    );

    const req = makeCancelRequest("apt-1", { reason: "SCHEDULE_CONFLICT" });
    await cancelHandler(req, makeParams("apt-1"));

    expect(notifyAppointmentCancelled).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({
        cancelledBy: "consultee",
      }),
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Cleanup Tentative Slots
// ═══════════════════════════════════════════════════════════════════════════════

describe("cleanupTentativeOccurrences", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // #1319 wave 6 — the sweep releases holds inside prisma.$transaction so
    // the tombstone and its history rows land together; hand the callback the
    // same mocked client so the per-model mocks below keep applying.
    (prisma.$transaction as jest.Mock).mockImplementation((arg: unknown) =>
      typeof arg === "function"
        ? (arg as (tx: typeof prisma) => unknown)(prisma)
        : Promise.all(arg as Promise<unknown>[]),
    );
  });

  it("should return success with 0 slots when none are stale", async () => {
    (prisma.appointmentOccurrence.findMany as jest.Mock).mockResolvedValue([]);

    const result = await cleanupTentativeOccurrences();

    expect(result.success).toBe(true);
    expect(result.slotsReleased).toBe(0);
    expect(result.appointmentsAffected).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it("should find and soft-cancel stale tentative slots", async () => {
    const staleSlots = [
      {
        id: "slot-1",
        appointmentId: "apt-1",
        startsAt: new Date("2025-01-01T10:00:00.000Z"),
        endsAt: new Date("2025-01-01T10:30:00.000Z"),
        isTentative: true,
        createdAt: new Date("2024-12-01T00:00:00.000Z"),
        updatedAt: new Date("2024-12-01T00:00:00.000Z"),
        appointment: {
          payment: [],
          consultation: {
            id: "cons-1",
            status: "PENDING",
            requestedBy: {
              user: { name: "Test User", email: "test@example.com" },
            },
          },
          subscription: null,
        },
      },
    ];

    (prisma.appointmentOccurrence.findMany as jest.Mock).mockResolvedValue(
      staleSlots,
    );
    (
      prisma.appointmentOccurrence as unknown as {
        updateManyAndReturn: jest.Mock;
      }
    ).updateManyAndReturn.mockResolvedValue([{ id: "slot-1" }]);

    const result = await cleanupTentativeOccurrences();

    expect(result.success).toBe(true);
    expect(result.slotsReleased).toBe(1);
    expect(result.appointmentsAffected).toBe(1);
  });

  it("should count unique appointment IDs for appointmentsAffected", async () => {
    const staleSlots = [
      {
        id: "slot-1",
        appointmentId: "apt-1",
        startsAt: new Date(),
        endsAt: new Date(),
        isTentative: true,
        createdAt: new Date("2024-12-01"),
        updatedAt: new Date("2024-12-01"),
        appointment: { payment: [], consultation: null, subscription: null },
      },
      {
        id: "slot-2",
        appointmentId: "apt-1", // same appointment
        startsAt: new Date(),
        endsAt: new Date(),
        isTentative: true,
        createdAt: new Date("2024-12-01"),
        updatedAt: new Date("2024-12-01"),
        appointment: { payment: [], consultation: null, subscription: null },
      },
      {
        id: "slot-3",
        appointmentId: "apt-2", // different appointment
        startsAt: new Date(),
        endsAt: new Date(),
        isTentative: true,
        createdAt: new Date("2024-12-01"),
        updatedAt: new Date("2024-12-01"),
        appointment: { payment: [], consultation: null, subscription: null },
      },
    ];

    (prisma.appointmentOccurrence.findMany as jest.Mock).mockResolvedValue(
      staleSlots,
    );
    (
      prisma.appointmentOccurrence as unknown as {
        updateManyAndReturn: jest.Mock;
      }
    ).updateManyAndReturn.mockResolvedValue([
      { id: "slot-1" },
      { id: "slot-2" },
      { id: "slot-3" },
    ]);

    const result = await cleanupTentativeOccurrences();

    expect(result.slotsReleased).toBe(3);
    expect(result.appointmentsAffected).toBe(2); // 2 unique appointments
  });

  it("should handle database errors gracefully", async () => {
    (prisma.appointmentOccurrence.findMany as jest.Mock).mockRejectedValue(
      new Error("Connection lost"),
    );

    const result = await cleanupTentativeOccurrences();

    expect(result.success).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("Connection lost");
    expect(result.slotsReleased).toBe(0);
  });

  it("should include timestamp in result", async () => {
    (prisma.appointmentOccurrence.findMany as jest.Mock).mockResolvedValue([]);

    const before = new Date().toISOString();
    const result = await cleanupTentativeOccurrences();
    const after = new Date().toISOString();

    expect(result.timestamp).toBeDefined();
    expect(result.timestamp >= before).toBe(true);
    expect(result.timestamp <= after).toBe(true);
  });

  it("should query for tentative slots with no successful payment", async () => {
    (prisma.appointmentOccurrence.findMany as jest.Mock).mockResolvedValue([]);

    await cleanupTentativeOccurrences();

    expect(
      prisma.appointmentOccurrence.findMany as jest.Mock,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          isTentative: true,
          appointment: expect.objectContaining({
            payment: {
              none: {
                paymentStatus: "SUCCEEDED",
              },
            },
            AND: expect.arrayContaining([
              expect.objectContaining({
                OR: expect.arrayContaining([{ consultation: null }]),
              }),
            ]),
          }),
        }),
      }),
    );
  });

  it("should not write when no stale slots found", async () => {
    (prisma.appointmentOccurrence.findMany as jest.Mock).mockResolvedValue([]);

    await cleanupTentativeOccurrences();

    expect(
      (
        prisma.appointmentOccurrence as unknown as {
          updateManyAndReturn: jest.Mock;
        }
      ).updateManyAndReturn,
    ).not.toHaveBeenCalled();
  });
});
