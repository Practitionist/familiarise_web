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
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    $transaction: jest.fn(),
    appointment: { findUnique: jest.fn() },
    slotOfAppointment: { findMany: jest.fn(), deleteMany: jest.fn() },
    $disconnect: jest.fn(),
  },
}));

// Mock next-auth
jest.mock("next-auth", () => ({
  getServerSession: jest.fn(),
}));

// Mock auth options (bracket path — literal directory name)
jest.mock("../../app/api/auth/[...nextauth]/options", () => ({
  __esModule: true,
  default: {},
}));

// Mock waitlist handler
jest.mock("../../lib/waitlist/slot-handler", () => ({
  handleSlotOpening: jest.fn().mockResolvedValue({ notified: 0 }),
}));

// Mock novu notifications
jest.mock("../../lib/novu", () => ({
  notifyAppointmentCancelled: jest.fn().mockResolvedValue(undefined),
}));

// ─── Imports ────────────────────────────────────────────────────────────────

import prisma from "@/lib/prisma";
import { getServerSession } from "next-auth";
import { handleSlotOpening } from "@/lib/waitlist/slot-handler";
import { notifyAppointmentCancelled } from "@/lib/novu";
import { POST as rescheduleHandler } from "@/app/api/appointments/[appointmentId]/reschedule/route";
import { POST as cancelHandler } from "@/app/api/appointments/[appointmentId]/cancel/route";
import {
  ReschedulePolicyError,
  AppointmentNotFoundError,
} from "@/utils/errors/RescheduleErrors";
import { CancelAppointmentSchema } from "@/schemas/appointments";
import { cleanupTentativeSlots } from "../../scripts/appointments/cleanup-tentative-slots";

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Create a Request for the reschedule endpoint */
function makeRescheduleRequest(
  appointmentId: string,
  type: string,
  body?: Record<string, any>,
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
  }) as any;
}

/** Create a Request for the cancel endpoint */
function makeCancelRequest(
  appointmentId: string,
  body?: Record<string, any>,
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
  }) as any;
}

/** Create params promise (Next.js 15 async params pattern) */
function makeParams(appointmentId: string) {
  return { params: Promise.resolve({ appointmentId }) };
}

// ─── Time Constants ─────────────────────────────────────────────────────────

const FUTURE_DATE = new Date(Date.now() + 48 * 60 * 60 * 1000); // 48h ahead
const NEAR_DATE = new Date(Date.now() + 12 * 60 * 60 * 1000); // 12h ahead

// ─── Slot & Appointment Factories ───────────────────────────────────────────

function makeSlot(id: string, startsAt: Date, overrides: any = {}) {
  return {
    id,
    startsAt,
    endsAt: new Date(startsAt.getTime() + 30 * 60 * 1000),
    isTentative: false,
    appointmentId: "apt-1",
    createdAt: new Date("2025-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

function makeConsultationAppointment(overrides: any = {}) {
  return {
    id: "apt-1",
    appointmentType: "CONSULTATION",
    slotsOfAppointment: [
      makeSlot("slot-1", FUTURE_DATE),
      makeSlot("slot-2", new Date(FUTURE_DATE.getTime() + 30 * 60 * 1000)),
    ],
    consultation: {
      id: "cons-1",
      consultationPlan: {
        title: "Test Plan",
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

function makeSubscriptionAppointment(overrides: any = {}) {
  return {
    id: "apt-1",
    appointmentType: "SUBSCRIPTION",
    slotsOfAppointment: [
      makeSlot("slot-1", FUTURE_DATE),
      makeSlot("slot-2", new Date(FUTURE_DATE.getTime() + 30 * 60 * 1000)),
    ],
    consultation: null,
    subscription: {
      id: "sub-1",
      subscriptionPlan: {
        title: "Monthly Plan",
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

function makeWebinarAppointment(overrides: any = {}) {
  return {
    id: "apt-1",
    appointmentType: "WEBINAR",
    slotsOfAppointment: [makeSlot("slot-1", FUTURE_DATE)],
    consultation: null,
    subscription: null,
    webinar: { id: "web-1", status: "SCHEDULED" },
    class: null,
    ...overrides,
  };
}

function makeClassAppointment(overrides: any = {}) {
  return {
    id: "apt-1",
    appointmentType: "CLASS",
    slotsOfAppointment: [makeSlot("slot-1", FUTURE_DATE)],
    consultation: null,
    subscription: null,
    webinar: null,
    class: { id: "cls-1", status: "SCHEDULED" },
    ...overrides,
  };
}

// ─── Mock Transaction Factory ───────────────────────────────────────────────

function makeMockTx() {
  return {
    appointment: {
      findUnique: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      delete: jest.fn(),
    },
    consultation: { update: jest.fn() },
    subscription: { update: jest.fn() },
    webinar: { update: jest.fn() },
    class: { update: jest.fn() },
    slotOfAppointment: { updateMany: jest.fn(), deleteMany: jest.fn() },
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
      expect(err.message).toBe(
        "Specified slot not found in this appointment",
      );
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
    if (result.success) {
      expect(result.data.reason).toBe("SCHEDULE_CONFLICT");
    }
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
    if (result.success) {
      expect(result.data.notes).toBe(
        "Need to cancel due to scheduling conflict",
      );
    }
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

    // Default: authenticated user
    (getServerSession as jest.Mock).mockResolvedValue({
      user: { id: "user-1", name: "John Doe" },
    });

    // Default: transaction passes callback through to mock tx
    (prisma.$transaction as jest.Mock).mockImplementation(
      async (callback: any) => callback(mockTx),
    );
  });

  // ─── Authentication ─────────────────────────────────────────────────────

  it("should return 401 when not authenticated", async () => {
    (getServerSession as jest.Mock).mockResolvedValue(null);

    const req = makeRescheduleRequest("apt-1", "CONSULTATION");
    const res = await rescheduleHandler(req, makeParams("apt-1"));
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.error).toBe("Unauthorized");
  });

  it("should return 401 when session has no user", async () => {
    (getServerSession as jest.Mock).mockResolvedValue({ user: null });

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
      slotsOfAppointment: [makeSlot("slot-1", NEAR_DATE)],
    });
    mockTx.appointment.findUnique.mockResolvedValue(appointment);

    const req = makeRescheduleRequest("apt-1", "CONSULTATION");
    const res = await rescheduleHandler(req, makeParams("apt-1"));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toContain("24 hours");
  });

  it("should enforce 24-hour restriction even if only one of multiple slots is near", async () => {
    const appointment = makeSubscriptionAppointment({
      slotsOfAppointment: [
        makeSlot("slot-1", FUTURE_DATE), // 48h ahead — OK
        makeSlot("slot-2", NEAR_DATE), // 12h ahead — too close
      ],
    });
    mockTx.appointment.findUnique.mockResolvedValue(appointment);

    mockTx.appointment.findMany.mockResolvedValueOnce([
      { id: "apt-1", slotsOfAppointment: appointment.slotsOfAppointment },
    ]);

    const req = makeRescheduleRequest("apt-1", "SUBSCRIPTION", {
      slotIds: ["slot-1", "slot-2"],
    });
    const res = await rescheduleHandler(req, makeParams("apt-1"));

    expect(res.status).toBe(400);
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
      expect(mockTx.slotOfAppointment.updateMany).toHaveBeenCalledWith({
        where: { appointmentId: "apt-1" },
        data: { isTentative: true },
      });

      // Verify consultation status reverted
      expect(mockTx.consultation.update).toHaveBeenCalledWith({
        where: { id: "cons-1" },
        data: { requestStatus: "PENDING" },
      });
    });
  });

  // ─── SUBSCRIPTION Reschedule ────────────────────────────────────────────

  describe("SUBSCRIPTION", () => {
    it("should mark ALL subscription slots tentative when no slotIds provided", async () => {
      const appointment = makeSubscriptionAppointment();
      mockTx.appointment.findUnique.mockResolvedValue(appointment);

      // First findMany: gather all subscription slots
      mockTx.appointment.findMany
        .mockResolvedValueOnce([
          { id: "apt-1", slotsOfAppointment: appointment.slotsOfAppointment },
          {
            id: "apt-2",
            slotsOfAppointment: [
              makeSlot(
                "slot-3",
                new Date(FUTURE_DATE.getTime() + 7 * 24 * 60 * 60 * 1000),
              ),
            ],
          },
        ])
        // Second findMany: get appointment IDs for updateMany
        .mockResolvedValueOnce([{ id: "apt-1" }, { id: "apt-2" }]);

      const req = makeRescheduleRequest("apt-1", "SUBSCRIPTION");
      const res = await rescheduleHandler(req, makeParams("apt-1"));
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.rescheduleType).toBe("entire_booking");

      // Should mark all appointment slots tentative
      expect(mockTx.slotOfAppointment.updateMany).toHaveBeenCalledWith({
        where: { appointmentId: { in: ["apt-1", "apt-2"] } },
        data: { isTentative: true },
      });

      // Should update subscription status
      expect(mockTx.subscription.update).toHaveBeenCalledWith({
        where: { id: "sub-1" },
        data: { requestStatus: "PENDING" },
      });
    });

    it("should mark only specified slots when slotIds provided (individual)", async () => {
      const appointment = makeSubscriptionAppointment();
      mockTx.appointment.findUnique.mockResolvedValue(appointment);

      mockTx.appointment.findMany.mockResolvedValueOnce([
        { id: "apt-1", slotsOfAppointment: appointment.slotsOfAppointment },
      ]);

      const req = makeRescheduleRequest("apt-1", "SUBSCRIPTION", {
        slotIds: ["slot-1"],
      });
      const res = await rescheduleHandler(req, makeParams("apt-1"));
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.rescheduleType).toBe("individual_session");
      expect(body.slotsAffected).toBe(1);

      expect(mockTx.slotOfAppointment.updateMany).toHaveBeenCalledWith({
        where: { id: { in: ["slot-1"] } },
        data: { isTentative: true },
      });
    });

    it("should return 'multiple_sessions' type for multiple slotIds", async () => {
      const appointment = makeSubscriptionAppointment();
      mockTx.appointment.findUnique.mockResolvedValue(appointment);

      mockTx.appointment.findMany.mockResolvedValueOnce([
        { id: "apt-1", slotsOfAppointment: appointment.slotsOfAppointment },
      ]);

      const req = makeRescheduleRequest("apt-1", "SUBSCRIPTION", {
        slotIds: ["slot-1", "slot-2"],
      });
      const res = await rescheduleHandler(req, makeParams("apt-1"));
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.rescheduleType).toBe("multiple_sessions");
      expect(body.slotsAffected).toBe(2);
    });

    it("should return 404 when requested slotIds not found in subscription", async () => {
      const appointment = makeSubscriptionAppointment();
      mockTx.appointment.findUnique.mockResolvedValue(appointment);

      mockTx.appointment.findMany.mockResolvedValueOnce([
        { id: "apt-1", slotsOfAppointment: appointment.slotsOfAppointment },
      ]);

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

      mockTx.appointment.findMany.mockResolvedValueOnce([
        { id: "apt-1", slotsOfAppointment: appointment.slotsOfAppointment },
      ]);

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
    it("should mark slots tentative and update webinar to SCHEDULED", async () => {
      const appointment = makeWebinarAppointment();
      mockTx.appointment.findUnique.mockResolvedValue(appointment);

      const req = makeRescheduleRequest("apt-1", "WEBINAR");
      const res = await rescheduleHandler(req, makeParams("apt-1"));
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.rescheduleType).toBe("entire_booking");

      expect(mockTx.slotOfAppointment.updateMany).toHaveBeenCalledWith({
        where: { appointmentId: "apt-1" },
        data: { isTentative: true },
      });

      expect(mockTx.webinar.update).toHaveBeenCalledWith({
        where: { id: "web-1" },
        data: { status: "SCHEDULED" },
      });
    });
  });

  // ─── CLASS Reschedule ───────────────────────────────────────────────────

  describe("CLASS", () => {
    it("should mark slots tentative and update class to SCHEDULED", async () => {
      const appointment = makeClassAppointment();
      mockTx.appointment.findUnique.mockResolvedValue(appointment);

      const req = makeRescheduleRequest("apt-1", "CLASS");
      const res = await rescheduleHandler(req, makeParams("apt-1"));
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.success).toBe(true);

      expect(mockTx.class.update).toHaveBeenCalledWith({
        where: { id: "cls-1" },
        data: { status: "SCHEDULED" },
      });
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
    mockTx.appointment.findMany.mockResolvedValueOnce([
      { id: "apt-1", slotsOfAppointment: appointment.slotsOfAppointment },
    ]);

    const req = makeRescheduleRequest("apt-1", "SUBSCRIPTION", {
      slotIds: ["slot-1"],
    });
    const res = await rescheduleHandler(req, makeParams("apt-1"));
    const body = await res.json();

    expect(body.message).toContain("session(s) marked for rescheduling");
  });

  // ─── Edge Cases ─────────────────────────────────────────────────────────

  it("should handle empty body gracefully", async () => {
    mockTx.appointment.findUnique.mockResolvedValue(
      makeConsultationAppointment(),
    );

    const req = new Request(
      "http://localhost/api/appointments/apt-1/reschedule?type=CONSULTATION",
      { method: "POST" },
    ) as any;
    const res = await rescheduleHandler(req, makeParams("apt-1"));

    expect(res.status).toBe(200);
  });

  it("should handle appointment with no slots", async () => {
    const appointment = makeConsultationAppointment({
      slotsOfAppointment: [],
    });
    mockTx.appointment.findUnique.mockResolvedValue(appointment);

    const req = makeRescheduleRequest("apt-1", "CONSULTATION");
    const res = await rescheduleHandler(req, makeParams("apt-1"));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.slotsAffected).toBe(0);
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

    // Default: authenticated
    (getServerSession as jest.Mock).mockResolvedValue({
      user: { id: "user-1", name: "John Doe" },
    });

    // Default: consultation appointment found (pre-transaction fetch)
    (prisma.appointment.findUnique as jest.Mock).mockResolvedValue(
      makeConsultationAppointment(),
    );

    // Default: transaction passes callback through
    (prisma.$transaction as jest.Mock).mockImplementation(
      async (callback: any) => callback(mockTx),
    );
  });

  // ─── Authentication ─────────────────────────────────────────────────────

  it("should return 401 when not authenticated", async () => {
    (getServerSession as jest.Mock).mockResolvedValue(null);

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
    it("should update consultation with cancellation data and delete slots/appointment", async () => {
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
      expect(mockTx.consultation.update).toHaveBeenCalledWith({
        where: { id: "cons-1" },
        data: expect.objectContaining({
          requestStatus: "CANCELLED",
          cancellationReason: "SCHEDULE_CONFLICT",
          cancellationNotes: "Cannot make it",
          cancelledBy: "user-1",
        }),
      });

      // Verify slots deleted
      expect(mockTx.slotOfAppointment.deleteMany).toHaveBeenCalledWith({
        where: { appointmentId: "apt-1" },
      });

      // Verify appointment deleted
      expect(mockTx.appointment.delete).toHaveBeenCalledWith({
        where: { id: "apt-1" },
      });
    });

    it("should delete slots before appointment (foreign key order)", async () => {
      const callOrder: string[] = [];
      mockTx.slotOfAppointment.deleteMany.mockImplementation(async () => {
        callOrder.push("deleteSlots");
      });
      mockTx.appointment.delete.mockImplementation(async () => {
        callOrder.push("deleteAppointment");
      });

      const req = makeCancelRequest("apt-1");
      await cancelHandler(req, makeParams("apt-1"));

      expect(callOrder).toEqual(["deleteSlots", "deleteAppointment"]);
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
      expect(mockTx.subscription.update).toHaveBeenCalledWith({
        where: { id: "sub-1" },
        data: expect.objectContaining({
          requestStatus: "CANCELLED",
          cancellationReason: "FINANCIAL_REASONS",
          cancelledBy: "user-1",
        }),
      });
    });
  });

  // ─── WEBINAR Cancellation ───────────────────────────────────────────────

  describe("WEBINAR", () => {
    it("should update webinar to CANCELLED and trigger waitlist", async () => {
      const appointment = makeWebinarAppointment();
      (prisma.appointment.findUnique as jest.Mock).mockResolvedValue(
        appointment,
      );

      const req = makeCancelRequest("apt-1");
      const res = await cancelHandler(req, makeParams("apt-1"));

      expect(res.status).toBe(200);

      expect(mockTx.webinar.update).toHaveBeenCalledWith({
        where: { id: "web-1" },
        data: { status: "CANCELLED" },
      });

      // Waitlist notified
      expect(handleSlotOpening).toHaveBeenCalledWith({
        webinarId: "web-1",
        classId: undefined,
        slotsAvailable: 1,
        reason: "cancellation",
      });
    });
  });

  // ─── CLASS Cancellation ─────────────────────────────────────────────────

  describe("CLASS", () => {
    it("should update class to CANCELLED and trigger waitlist", async () => {
      const appointment = makeClassAppointment();
      (prisma.appointment.findUnique as jest.Mock).mockResolvedValue(
        appointment,
      );

      const req = makeCancelRequest("apt-1");
      const res = await cancelHandler(req, makeParams("apt-1"));

      expect(res.status).toBe(200);

      expect(mockTx.class.update).toHaveBeenCalledWith({
        where: { id: "cls-1" },
        data: { status: "CANCELLED" },
      });

      expect(handleSlotOpening).toHaveBeenCalledWith({
        classId: "cls-1",
        webinarId: undefined,
        slotsAvailable: 1,
        reason: "cancellation",
      });
    });
  });

  // ─── No Body ───────────────────────────────────────────────────────────

  it("should cancel without reason when no body provided", async () => {
    (prisma.appointment.findUnique as jest.Mock).mockResolvedValue(
      makeConsultationAppointment(),
    );

    const req = new Request(
      "http://localhost/api/appointments/apt-1/cancel",
      { method: "POST" },
    ) as any;
    const res = await cancelHandler(req, makeParams("apt-1"));

    expect(res.status).toBe(200);

    // Cancellation data should have null reason and notes
    expect(mockTx.consultation.update).toHaveBeenCalledWith({
      where: { id: "cons-1" },
      data: expect.objectContaining({
        requestStatus: "CANCELLED",
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

  it("should not call waitlist for non-webinar/class cancellations", async () => {
    (prisma.appointment.findUnique as jest.Mock).mockResolvedValue(
      makeConsultationAppointment(),
    );

    const req = makeCancelRequest("apt-1");
    await cancelHandler(req, makeParams("apt-1"));

    expect(handleSlotOpening).not.toHaveBeenCalled();
  });

  it("should handle waitlist notification failure gracefully", async () => {
    (prisma.appointment.findUnique as jest.Mock).mockResolvedValue(
      makeWebinarAppointment(),
    );

    (handleSlotOpening as jest.Mock).mockRejectedValue(
      new Error("Waitlist service down"),
    );

    const req = makeCancelRequest("apt-1");
    const res = await cancelHandler(req, makeParams("apt-1"));

    // Should still succeed — waitlist notification is best-effort
    expect(res.status).toBe(200);
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
    (getServerSession as jest.Mock).mockResolvedValue({
      user: { id: "consultant-1", name: "Dr. Smith" },
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
    (getServerSession as jest.Mock).mockResolvedValue({
      user: { id: "user-1", name: "John Doe" },
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

describe("cleanupTentativeSlots", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("should return success with 0 slots when none are stale", async () => {
    (prisma.slotOfAppointment as any).findMany.mockResolvedValue([]);

    const result = await cleanupTentativeSlots();

    expect(result.success).toBe(true);
    expect(result.slotsReleased).toBe(0);
    expect(result.appointmentsAffected).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it("should find and delete stale tentative slots", async () => {
    const staleSlots = [
      {
        id: "slot-1",
        appointmentId: "apt-1",
        startsAt: new Date("2025-01-01T10:00:00.000Z"),
        endsAt: new Date("2025-01-01T10:30:00.000Z"),
        isTentative: true,
        createdAt: new Date("2024-12-01T00:00:00.000Z"),
        appointment: {
          payment: [],
          consultation: {
            id: "cons-1",
            requestStatus: "PENDING",
            requestedBy: {
              user: { name: "Test User", email: "test@example.com" },
            },
          },
          subscription: null,
        },
      },
    ];

    (prisma.slotOfAppointment as any).findMany.mockResolvedValue(staleSlots);
    (prisma.slotOfAppointment as any).deleteMany.mockResolvedValue({
      count: 1,
    });

    const result = await cleanupTentativeSlots();

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
        appointment: { payment: [], consultation: null, subscription: null },
      },
      {
        id: "slot-2",
        appointmentId: "apt-1", // same appointment
        startsAt: new Date(),
        endsAt: new Date(),
        isTentative: true,
        createdAt: new Date("2024-12-01"),
        appointment: { payment: [], consultation: null, subscription: null },
      },
      {
        id: "slot-3",
        appointmentId: "apt-2", // different appointment
        startsAt: new Date(),
        endsAt: new Date(),
        isTentative: true,
        createdAt: new Date("2024-12-01"),
        appointment: { payment: [], consultation: null, subscription: null },
      },
    ];

    (prisma.slotOfAppointment as any).findMany.mockResolvedValue(staleSlots);
    (prisma.slotOfAppointment as any).deleteMany.mockResolvedValue({
      count: 3,
    });

    const result = await cleanupTentativeSlots();

    expect(result.slotsReleased).toBe(3);
    expect(result.appointmentsAffected).toBe(2); // 2 unique appointments
  });

  it("should handle database errors gracefully", async () => {
    (prisma.slotOfAppointment as any).findMany.mockRejectedValue(
      new Error("Connection lost"),
    );

    const result = await cleanupTentativeSlots();

    expect(result.success).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("Connection lost");
    expect(result.slotsReleased).toBe(0);
  });

  it("should include timestamp in result", async () => {
    (prisma.slotOfAppointment as any).findMany.mockResolvedValue([]);

    const before = new Date().toISOString();
    const result = await cleanupTentativeSlots();
    const after = new Date().toISOString();

    expect(result.timestamp).toBeDefined();
    expect(result.timestamp >= before).toBe(true);
    expect(result.timestamp <= after).toBe(true);
  });

  it("should query for tentative slots with no successful payment", async () => {
    (prisma.slotOfAppointment as any).findMany.mockResolvedValue([]);

    await cleanupTentativeSlots();

    expect((prisma.slotOfAppointment as any).findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          isTentative: true,
          appointment: {
            payment: {
              none: {
                paymentStatus: "SUCCEEDED",
              },
            },
          },
        }),
      }),
    );
  });

  it("should not call deleteMany when no stale slots found", async () => {
    (prisma.slotOfAppointment as any).findMany.mockResolvedValue([]);

    await cleanupTentativeSlots();

    expect(
      (prisma.slotOfAppointment as any).deleteMany,
    ).not.toHaveBeenCalled();
  });
});
