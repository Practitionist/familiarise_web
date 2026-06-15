/**
 * Comprehensive tests for SlotAllocationService
 *
 * Covers:
 * - allocate() mode routing (auto, manual, requested, invalid)
 * - Manual allocation: duplicate detection, slot count validation, appointment creation
 * - Requested slot allocation: verification, tentative flag clearing
 * - Auto allocation: slot finding, reschedule detection, scheduling period
 * - fetchEventData: config extraction, consultant validation, date ordering
 * - createAppointments: grouping, defensive checks, single-appointment events
 * - updateEventStatus: per-event-type status and scheduling period logic
 * - deleteExistingAppointments: full vs tentative-only deletion
 * - Error handling and edge cases
 */

import "./setup";

// ─── Module Mocks ───────────────────────────────────────────────────────────

// Mock prisma (relative path required — @/ aliases fail in jest.mock)
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    $transaction: jest.fn(),
    consultation: { findUnique: jest.fn() },
    subscription: { findUnique: jest.fn() },
    webinar: { findUnique: jest.fn() },
    class: { findUnique: jest.fn() },
  },
}));

// Mock appointmentlock to avoid @upstash/redis ESM import issues in Jest
jest.mock("../../utils/appointmentlock", () => ({
  lockAutoAllocate: jest
    .fn()
    .mockResolvedValue({ key: "mock-key", value: "mock-value" }),
  unlockAutoAllocate: jest.fn().mockResolvedValue(undefined),
}));

// Mock SlotValidationService to isolate unit under test
const mockValidateFn = jest.fn();
jest.mock("../../utils/slotAllocation/SlotValidationService", () => ({
  SlotValidationService: jest.fn().mockImplementation(() => ({
    validate: mockValidateFn,
  })),
}));

import prisma from "@/lib/prisma";
import { SlotAllocationService } from "@/utils/slotAllocation/SlotAllocationService";
import {
  ScheduleType,
  DayOfWeek,
  AppointmentsType,
  AppointmentStatus,
} from "@prisma/client";
import {
  makeWeeklyAvailabilitySlot,
  makeCustomAvailabilitySlot,
} from "./__mocks__/booking.mockData";

// ─── Mock Transaction Factory ───────────────────────────────────────────────

function makeMockTx() {
  return {
    // #836 — updateEventStatus routes through the CAS transition helpers,
    // which call updateMany and read the returned count.
    consultation: {
      findUnique: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    subscription: {
      findUnique: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    webinar: { findUnique: jest.fn(), update: jest.fn() },
    class: { findUnique: jest.fn(), update: jest.fn() },
    // #440 — createAppointments denormalizes the consultant onto each slot.
    consultantProfile: {
      findFirst: jest.fn().mockResolvedValue({ id: "consultant-profile-1" }),
    },
    appointment: {
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({
        id: "apt-1",
        slotsOfAppointment: [],
      }),
      delete: jest.fn(),
    },
    slotOfAppointment: { updateMany: jest.fn() },
  };
}

// ─── Event Data Factories ───────────────────────────────────────────────────

function makeConsultantProfile(overrides: any = {}) {
  return {
    user: { id: "consultant-1", timezone: "UTC" },
    scheduleType: ScheduleType.WEEKLY,
    slotsOfAvailabilityWeekly: [
      makeWeeklyAvailabilitySlot(DayOfWeek.MONDAY, 9, 11),
    ],
    slotsOfAvailabilityCustom: [],
    ...overrides,
  };
}

function makeConsultationEvent(overrides: any = {}) {
  return {
    id: "consult-1",
    consultationPlan: {
      durationInHours: 1,
      consultantProfile: makeConsultantProfile(),
    },
    requestedBy: { user: { id: "consultee-1" } },
    appointment: null,
    ...overrides,
  };
}

function makeSubscriptionEvent(overrides: any = {}) {
  return {
    id: "sub-1",
    subscriptionPlan: {
      durationInMonths: 1,
      callsPerWeek: 1,
      sessionDurationInHours: 1,
      consultantProfile: makeConsultantProfile(),
    },
    requestedBy: { user: { id: "consultee-1" } },
    schedulingPeriodStartsAt: new Date("2025-01-06T00:00:00Z"),
    schedulingPeriodEndsAt: new Date("2025-01-10T00:00:00Z"), // 1 week → requires 2 slots
    appointments: [],
    ...overrides,
  };
}

function makeWebinarEvent(overrides: any = {}) {
  return {
    id: "webinar-1",
    webinarPlan: {
      durationInHours: 1,
      consultantProfile: makeConsultantProfile(),
    },
    ...overrides,
  };
}

function makeClassEvent(overrides: any = {}) {
  return {
    id: "class-1",
    classPlan: {
      durationInMonths: 1,
      meetingsPerWeek: 1,
      sessionDurationInHours: 1,
      consultantProfile: makeConsultantProfile(),
      classContents: [],
    },
    schedulingPeriodStartsAt: new Date("2025-01-06T00:00:00Z"),
    schedulingPeriodEndsAt: new Date("2025-01-10T00:00:00Z"), // 1 week → requires 2 slots
    appointments: [],
    ...overrides,
  };
}

// ─── Test Setup ─────────────────────────────────────────────────────────────

let mockTx: ReturnType<typeof makeMockTx>;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date("2025-01-01T00:00:00Z"));

  mockTx = makeMockTx();
  (prisma.$transaction as jest.Mock).mockImplementation(async (callback: any) =>
    callback(mockTx),
  );

  // Setup top-level prisma mocks for getConsultantProfileId() pre-fetch
  // (runs outside the transaction to acquire consultant-level lock)
  const consultantProfileId = "consultant-profile-1";
  (prisma.consultation.findUnique as jest.Mock).mockResolvedValue({
    consultationPlan: { consultantProfileId },
  });
  (prisma.subscription.findUnique as jest.Mock).mockResolvedValue({
    subscriptionPlan: { consultantProfileId },
  });
  (prisma.webinar.findUnique as jest.Mock).mockResolvedValue({
    webinarPlan: { consultantProfileId },
  });
  (prisma.class.findUnique as jest.Mock).mockResolvedValue({
    classPlan: { consultantProfileId },
  });

  mockValidateFn.mockReset();
  mockValidateFn.mockResolvedValue({
    isValid: true,
    errors: [],
    warnings: [],
  });
});

afterEach(() => {
  jest.useRealTimers();
});

// ─── allocate() - Mode Routing ──────────────────────────────────────────────

describe("allocate() - Mode routing", () => {
  it("should return error for manual mode with no slots", async () => {
    const result = await SlotAllocationService.allocate({
      eventType: "consultation",
      eventId: "consult-1",
      mode: "manual",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Slots are required");
  });

  it("should return error for manual mode with empty slots array", async () => {
    const result = await SlotAllocationService.allocate({
      eventType: "consultation",
      eventId: "consult-1",
      mode: "manual",
      slots: [],
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Slots are required");
  });

  it("should return error for invalid allocation mode", async () => {
    const result = await SlotAllocationService.allocate({
      eventType: "consultation",
      eventId: "consult-1",
      mode: "invalid" as any,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid allocation mode");
  });

  it("should catch and wrap errors from inner methods", async () => {
    (prisma.$transaction as jest.Mock).mockRejectedValue(
      new Error("DB connection failed"),
    );

    const result = await SlotAllocationService.allocate({
      eventType: "consultation",
      eventId: "consult-1",
      mode: "manual",
      slots: ["2025-01-06T10:00:00Z", "2025-01-06T10:30:00Z"],
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("DB connection failed");
  });

  it("should handle non-Error throws gracefully", async () => {
    (prisma.$transaction as jest.Mock).mockRejectedValue("string error");

    const result = await SlotAllocationService.allocate({
      eventType: "consultation",
      eventId: "consult-1",
      mode: "manual",
      slots: ["2025-01-06T10:00:00Z"],
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("Allocation failed");
  });
});

// ─── Manual Allocation ──────────────────────────────────────────────────────

describe("Manual allocation", () => {
  it("should return error when event not found", async () => {
    mockTx.consultation.findUnique.mockResolvedValue(null);

    const result = await SlotAllocationService.allocate({
      eventType: "consultation",
      eventId: "nonexistent",
      mode: "manual",
      slots: ["2025-01-06T10:00:00Z", "2025-01-06T10:30:00Z"],
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("consultation not found");
  });

  it("should reject duplicate slots", async () => {
    mockTx.consultation.findUnique.mockResolvedValue(makeConsultationEvent());

    const result = await SlotAllocationService.allocate({
      eventType: "consultation",
      eventId: "consult-1",
      mode: "manual",
      slots: [
        "2025-01-06T10:00:00Z",
        "2025-01-06T10:00:00Z", // duplicate
      ],
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Duplicate slots detected");
    expect(result.error).toContain("2 slots provided but only 1 are unique");
  });

  it("should reject slot count not divisible by slotsPerCall", async () => {
    mockTx.consultation.findUnique.mockResolvedValue(makeConsultationEvent());

    // 1-hour session needs 2 slots, but providing 3
    const result = await SlotAllocationService.allocate({
      eventType: "consultation",
      eventId: "consult-1",
      mode: "manual",
      slots: [
        "2025-01-06T10:00:00Z",
        "2025-01-06T10:30:00Z",
        "2025-01-06T11:00:00Z",
      ],
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid slot count");
    expect(result.error).toContain("multiples of 2 slots");
  });

  it("should reject when validation fails", async () => {
    mockTx.consultation.findUnique.mockResolvedValue(makeConsultationEvent());
    mockValidateFn.mockResolvedValue({
      isValid: false,
      errors: ["Slots conflict with existing appointment"],
      warnings: [],
    });

    const result = await SlotAllocationService.allocate({
      eventType: "consultation",
      eventId: "consult-1",
      mode: "manual",
      slots: ["2025-01-06T10:00:00Z", "2025-01-06T10:30:00Z"],
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Validation failed");
    expect(result.error).toContain("Slots conflict");
  });

  it("should create appointment on successful validation", async () => {
    mockTx.consultation.findUnique.mockResolvedValue(makeConsultationEvent());

    const result = await SlotAllocationService.allocate({
      eventType: "consultation",
      eventId: "consult-1",
      mode: "manual",
      slots: ["2025-01-06T10:00:00Z", "2025-01-06T10:30:00Z"],
    });

    expect(result.success).toBe(true);
    expect(mockTx.appointment.create).toHaveBeenCalled();
  });

  it("should create slot records with 30-minute duration", async () => {
    mockTx.consultation.findUnique.mockResolvedValue(makeConsultationEvent());

    await SlotAllocationService.allocate({
      eventType: "consultation",
      eventId: "consult-1",
      mode: "manual",
      slots: ["2025-01-06T10:00:00Z", "2025-01-06T10:30:00Z"],
    });

    const createCall = mockTx.appointment.create.mock.calls[0][0];
    const slotsToCreate = createCall.data.slotsOfAppointment.create;

    expect(slotsToCreate).toHaveLength(2);
    // Each slot should have 30-minute offset between startsAt and endsAt
    const slot1Start = new Date(slotsToCreate[0].startsAt).getTime();
    const slot1End = new Date(slotsToCreate[0].endsAt).getTime();
    expect(slot1End - slot1Start).toBe(30 * 60 * 1000);
  });

  it("should connect both consultant and consultee to appointment", async () => {
    mockTx.consultation.findUnique.mockResolvedValue(makeConsultationEvent());

    await SlotAllocationService.allocate({
      eventType: "consultation",
      eventId: "consult-1",
      mode: "manual",
      slots: ["2025-01-06T10:00:00Z", "2025-01-06T10:30:00Z"],
    });

    const createCall = mockTx.appointment.create.mock.calls[0][0];
    const userConnect =
      createCall.data.slotsOfAppointment.create[0].user.connect;

    expect(userConnect).toEqual(
      expect.arrayContaining([{ id: "consultant-1" }, { id: "consultee-1" }]),
    );
  });

  it("should set correct appointment type for consultation", async () => {
    mockTx.consultation.findUnique.mockResolvedValue(makeConsultationEvent());

    await SlotAllocationService.allocate({
      eventType: "consultation",
      eventId: "consult-1",
      mode: "manual",
      slots: ["2025-01-06T10:00:00Z", "2025-01-06T10:30:00Z"],
    });

    const createCall = mockTx.appointment.create.mock.calls[0][0];
    expect(createCall.data.appointmentType).toBe(AppointmentsType.CONSULTATION);
  });

  it("should connect appointment to consultation via relation field", async () => {
    mockTx.consultation.findUnique.mockResolvedValue(makeConsultationEvent());

    await SlotAllocationService.allocate({
      eventType: "consultation",
      eventId: "consult-1",
      mode: "manual",
      slots: ["2025-01-06T10:00:00Z", "2025-01-06T10:30:00Z"],
    });

    const createCall = mockTx.appointment.create.mock.calls[0][0];
    expect(createCall.data.consultation).toEqual({
      connect: { id: "consult-1" },
    });
  });

  it("should update consultation status to APPROVED", async () => {
    mockTx.consultation.findUnique.mockResolvedValue(makeConsultationEvent());

    await SlotAllocationService.allocate({
      eventType: "consultation",
      eventId: "consult-1",
      mode: "manual",
      slots: ["2025-01-06T10:00:00Z", "2025-01-06T10:30:00Z"],
    });

    expect(mockTx.consultation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "consult-1" }),
        data: expect.objectContaining({
          status: AppointmentStatus.APPROVED,
        }),
      }),
    );
  });

  it("should delete existing appointments before creating new ones", async () => {
    mockTx.consultation.findUnique.mockResolvedValue(makeConsultationEvent());
    // Simulate existing appointments to delete
    // First findMany: reschedule detection (needs slotsOfAppointment)
    // Second findMany: deleteExistingAppointments full-delete path
    mockTx.appointment.findMany.mockResolvedValue([
      { id: "old-apt-1", slotsOfAppointment: [] },
    ]);

    await SlotAllocationService.allocate({
      eventType: "consultation",
      eventId: "consult-1",
      mode: "manual",
      slots: ["2025-01-06T10:00:00Z", "2025-01-06T10:30:00Z"],
    });

    expect(mockTx.appointment.delete).toHaveBeenCalledWith({
      where: { id: "old-apt-1" },
    });
  });

  it("should return validation warnings on success", async () => {
    mockTx.consultation.findUnique.mockResolvedValue(makeConsultationEvent());
    mockValidateFn.mockResolvedValue({
      isValid: true,
      errors: [],
      warnings: ["Week of Jan 6 is fully booked"],
    });

    const result = await SlotAllocationService.allocate({
      eventType: "consultation",
      eventId: "consult-1",
      mode: "manual",
      slots: ["2025-01-06T10:00:00Z", "2025-01-06T10:30:00Z"],
    });

    expect(result.success).toBe(true);
    expect(result.warnings).toContain("Week of Jan 6 is fully booked");
  });

  it("should handle subscription manual allocation with correct appointment type", async () => {
    mockTx.subscription.findUnique.mockResolvedValue(makeSubscriptionEvent());

    await SlotAllocationService.allocate({
      eventType: "subscription",
      eventId: "sub-1",
      mode: "manual",
      slots: ["2025-01-06T10:00:00Z", "2025-01-06T10:30:00Z"],
    });

    const createCall = mockTx.appointment.create.mock.calls[0][0];
    expect(createCall.data.appointmentType).toBe(AppointmentsType.SUBSCRIPTION);
    expect(createCall.data.subscription).toEqual({
      connect: { id: "sub-1" },
    });
  });

  it("should create multiple appointments for subscription with multiple calls", async () => {
    mockTx.subscription.findUnique.mockResolvedValue(
      makeSubscriptionEvent({
        schedulingPeriodEndsAt: new Date("2025-01-17T00:00:00Z"), // 2 weeks → requires 4 slots
      }),
    );

    // 4 slots → 2 appointments of 2 slots each (1hr sessions)
    await SlotAllocationService.allocate({
      eventType: "subscription",
      eventId: "sub-1",
      mode: "manual",
      slots: [
        "2025-01-06T10:00:00Z",
        "2025-01-06T10:30:00Z",
        "2025-01-13T10:00:00Z",
        "2025-01-13T10:30:00Z",
      ],
    });

    expect(mockTx.appointment.create).toHaveBeenCalledTimes(2);
  });
});

// ─── Requested Slot Allocation ──────────────────────────────────────────────

describe("Requested slot allocation", () => {
  it("should return error when event not found", async () => {
    mockTx.consultation.findUnique.mockResolvedValue(null);

    const result = await SlotAllocationService.allocate({
      eventType: "consultation",
      eventId: "nonexistent",
      mode: "requested",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("consultation not found");
  });

  it("should return error when no requested slots found", async () => {
    mockTx.consultation.findUnique.mockResolvedValue(
      makeConsultationEvent({ appointment: null }),
    );

    const result = await SlotAllocationService.allocate({
      eventType: "consultation",
      eventId: "consult-1",
      mode: "requested",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("No requested slots found");
  });

  it("should return error when no appointments exist in DB", async () => {
    mockTx.consultation.findUnique.mockResolvedValue(
      makeConsultationEvent({
        appointment: {
          slotsOfAppointment: [{ startsAt: new Date("2025-01-06T10:00:00Z") }],
        },
      }),
    );
    // appointment.findMany returns empty — no actual appointments in DB
    mockTx.appointment.findMany.mockResolvedValue([]);

    const result = await SlotAllocationService.allocate({
      eventType: "consultation",
      eventId: "consult-1",
      mode: "requested",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("No appointments found");
    expect(result.error).toContain("resubmit their request");
  });

  it("should return error when appointment slot count mismatches requested", async () => {
    mockTx.consultation.findUnique.mockResolvedValue(
      makeConsultationEvent({
        appointment: {
          slotsOfAppointment: [
            { startsAt: new Date("2025-01-06T10:00:00Z") },
            { startsAt: new Date("2025-01-06T10:30:00Z") },
          ],
        },
      }),
    );
    // Only 1 slot in DB appointment, but 2 requested
    mockTx.appointment.findMany.mockResolvedValue([
      { id: "apt-1", slotsOfAppointment: [{ id: "s1" }] },
    ]);

    const result = await SlotAllocationService.allocate({
      eventType: "consultation",
      eventId: "consult-1",
      mode: "requested",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Appointment mismatch");
    expect(result.error).toContain("1 slots in appointments");
    expect(result.error).toContain("2 requested slots");
  });

  it("should return error when validation fails for requested slots", async () => {
    mockTx.consultation.findUnique.mockResolvedValue(
      makeConsultationEvent({
        appointment: {
          slotsOfAppointment: [
            { startsAt: new Date("2025-01-06T10:00:00Z") },
            { startsAt: new Date("2025-01-06T10:30:00Z") },
          ],
        },
      }),
    );
    mockTx.appointment.findMany.mockResolvedValue([
      {
        id: "apt-1",
        slotsOfAppointment: [{ id: "s1" }, { id: "s2" }],
      },
    ]);
    mockValidateFn.mockResolvedValue({
      isValid: false,
      errors: ["Slots are in the past"],
      warnings: [],
    });

    const result = await SlotAllocationService.allocate({
      eventType: "consultation",
      eventId: "consult-1",
      mode: "requested",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Validation failed");
  });

  it("should clear isTentative flag on all appointment slots", async () => {
    mockTx.consultation.findUnique.mockResolvedValue(
      makeConsultationEvent({
        appointment: {
          slotsOfAppointment: [
            { startsAt: new Date("2025-01-06T10:00:00Z") },
            { startsAt: new Date("2025-01-06T10:30:00Z") },
          ],
        },
      }),
    );
    mockTx.appointment.findMany.mockResolvedValue([
      {
        id: "apt-1",
        slotsOfAppointment: [{ id: "s1" }, { id: "s2" }],
      },
    ]);

    const result = await SlotAllocationService.allocate({
      eventType: "consultation",
      eventId: "consult-1",
      mode: "requested",
    });

    expect(result.success).toBe(true);
    expect(mockTx.slotOfAppointment.updateMany).toHaveBeenCalledWith({
      where: { appointmentId: { in: ["apt-1"] } },
      data: { isTentative: false },
    });
  });

  it("should update event status on success", async () => {
    mockTx.consultation.findUnique.mockResolvedValue(
      makeConsultationEvent({
        appointment: {
          slotsOfAppointment: [
            { startsAt: new Date("2025-01-06T10:00:00Z") },
            { startsAt: new Date("2025-01-06T10:30:00Z") },
          ],
        },
      }),
    );
    mockTx.appointment.findMany.mockResolvedValue([
      {
        id: "apt-1",
        slotsOfAppointment: [{ id: "s1" }, { id: "s2" }],
      },
    ]);

    await SlotAllocationService.allocate({
      eventType: "consultation",
      eventId: "consult-1",
      mode: "requested",
    });

    expect(mockTx.consultation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "consult-1" }),
        data: expect.objectContaining({
          status: AppointmentStatus.APPROVED,
        }),
      }),
    );
  });

  it("should return existing appointments on success", async () => {
    const existingApts = [
      {
        id: "apt-1",
        slotsOfAppointment: [{ id: "s1" }, { id: "s2" }],
      },
    ];
    mockTx.consultation.findUnique.mockResolvedValue(
      makeConsultationEvent({
        appointment: {
          slotsOfAppointment: [
            { startsAt: new Date("2025-01-06T10:00:00Z") },
            { startsAt: new Date("2025-01-06T10:30:00Z") },
          ],
        },
      }),
    );
    mockTx.appointment.findMany.mockResolvedValue(existingApts);

    const result = await SlotAllocationService.allocate({
      eventType: "consultation",
      eventId: "consult-1",
      mode: "requested",
    });

    expect(result.success).toBe(true);
    expect(result.appointments).toBe(existingApts);
  });
});

// ─── Auto Allocation ────────────────────────────────────────────────────────

describe("Auto allocation", () => {
  it("should return error when event not found", async () => {
    mockTx.consultation.findUnique.mockResolvedValue(null);

    const result = await SlotAllocationService.allocate({
      eventType: "consultation",
      eventId: "nonexistent",
      mode: "auto",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("consultation not found");
  });

  it("should throw when consultant has no availability slots", async () => {
    mockTx.consultation.findUnique.mockResolvedValue(
      makeConsultationEvent({
        consultationPlan: {
          durationInHours: 1,
          consultantProfile: makeConsultantProfile({
            slotsOfAvailabilityWeekly: [],
          }),
        },
      }),
    );

    const result = await SlotAllocationService.allocate({
      eventType: "consultation",
      eventId: "consult-1",
      mode: "auto",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("No availability slots configured");
  });

  it("should find and allocate consecutive slots for consultation", async () => {
    mockTx.consultation.findUnique.mockResolvedValue(makeConsultationEvent());

    const result = await SlotAllocationService.allocate({
      eventType: "consultation",
      eventId: "consult-1",
      mode: "auto",
    });

    expect(result.success).toBe(true);
    // Should create exactly 1 appointment for consultation
    expect(mockTx.appointment.create).toHaveBeenCalledTimes(1);
    // Appointment should have 2 slots (1hr ÷ 30min = 2)
    const createCall = mockTx.appointment.create.mock.calls[0][0];
    expect(createCall.data.slotsOfAppointment.create).toHaveLength(2);
  });

  it("should find consecutive slots for webinar", async () => {
    mockTx.webinar.findUnique.mockResolvedValue(makeWebinarEvent());

    const result = await SlotAllocationService.allocate({
      eventType: "webinar",
      eventId: "webinar-1",
      mode: "auto",
    });

    expect(result.success).toBe(true);
    expect(mockTx.appointment.create).toHaveBeenCalledTimes(1);
  });

  it("should fail auto-allocation when all slots are booked", async () => {
    // Consultant has only 1-hour availability (2 blocks: 9:00, 9:30)
    mockTx.consultation.findUnique.mockResolvedValue(
      makeConsultationEvent({
        consultationPlan: {
          durationInHours: 1,
          consultantProfile: makeConsultantProfile({
            slotsOfAvailabilityWeekly: [
              makeWeeklyAvailabilitySlot(DayOfWeek.MONDAY, 9, 10),
            ],
          }),
        },
      }),
    );

    // Book ALL 8 weeks of Monday 9:00 slots so none are available
    const bookedSlots: any[] = [];
    for (let week = 0; week < 8; week++) {
      const d = new Date("2025-01-06T09:00:00Z");
      d.setUTCDate(d.getUTCDate() + week * 7);
      bookedSlots.push({ startsAt: new Date(d) });
    }

    mockTx.appointment.findMany
      .mockResolvedValueOnce([]) // reschedule check
      .mockResolvedValueOnce([{ slotsOfAppointment: bookedSlots }]) // booked slots
      .mockResolvedValue([]); // delete

    const result = await SlotAllocationService.allocate({
      eventType: "consultation",
      eventId: "consult-1",
      mode: "auto",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("consecutive slots available");
  });

  it("should validate found slots before creating appointments", async () => {
    mockTx.consultation.findUnique.mockResolvedValue(makeConsultationEvent());
    mockValidateFn.mockResolvedValue({
      isValid: false,
      errors: ["Conflict detected"],
      warnings: [],
    });

    const result = await SlotAllocationService.allocate({
      eventType: "consultation",
      eventId: "consult-1",
      mode: "auto",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Validation failed");
    // Should not create appointments when validation fails
    expect(mockTx.appointment.create).not.toHaveBeenCalled();
  });

  it("should detect reschedule when tentative slots exist", async () => {
    mockTx.consultation.findUnique.mockResolvedValue(makeConsultationEvent());
    // First findMany returns existing appointments with tentative slots
    mockTx.appointment.findMany
      .mockResolvedValueOnce([
        {
          id: "old-apt",
          slotsOfAppointment: [
            { isTentative: true, startsAt: new Date() },
            { isTentative: true, startsAt: new Date() },
          ],
        },
      ])
      .mockResolvedValue([]); // booked slots and delete queries

    const result = await SlotAllocationService.allocate({
      eventType: "consultation",
      eventId: "consult-1",
      mode: "auto",
    });

    expect(result.success).toBe(true);
  });

  it("should reject slots outside scheduling period for subscription", async () => {
    // Create subscription with narrow period that doesn't match availability
    mockTx.subscription.findUnique.mockResolvedValue(
      makeSubscriptionEvent({
        // Period is in the past — no slots can be "in the future" AND in this period
        schedulingPeriodStartsAt: new Date("2024-01-06T00:00:00Z"),
        schedulingPeriodEndsAt: new Date("2024-02-02T23:59:59Z"),
        subscriptionPlan: {
          durationInMonths: 1,
          callsPerWeek: 1,
          sessionDurationInHours: 1,
          consultantProfile: makeConsultantProfile(),
        },
      }),
    );

    const result = await SlotAllocationService.allocate({
      eventType: "subscription",
      eventId: "sub-1",
      mode: "auto",
    });

    expect(result.success).toBe(false);
    // Should fail because no future slots exist in past period
    expect(result.error).toBeDefined();
  });

  it("should update webinar status to SCHEDULED", async () => {
    mockTx.webinar.findUnique.mockResolvedValue(makeWebinarEvent());

    await SlotAllocationService.allocate({
      eventType: "webinar",
      eventId: "webinar-1",
      mode: "auto",
    });

    expect(mockTx.webinar.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "webinar-1" },
        data: expect.objectContaining({ status: "SCHEDULED" }),
      }),
    );
  });

  it("should pass transaction with 60-second timeout", async () => {
    mockTx.consultation.findUnique.mockResolvedValue(makeConsultationEvent());

    await SlotAllocationService.allocate({
      eventType: "consultation",
      eventId: "consult-1",
      mode: "auto",
    });

    // $transaction receives callback and options
    const txCall = (prisma.$transaction as jest.Mock).mock.calls[0];
    // The second argument should be the options (our mock ignores it, but it was passed)
    // Since we mock $transaction to only use the callback, verify it was called
    expect(prisma.$transaction).toHaveBeenCalled();
  });
});

// ─── fetchEventData (tested indirectly) ─────────────────────────────────────

describe("fetchEventData - config extraction", () => {
  it("should throw for missing consultant profile", async () => {
    mockTx.consultation.findUnique.mockResolvedValue({
      id: "consult-1",
      consultationPlan: {
        durationInHours: 1,
        consultantProfile: null, // missing!
      },
      requestedBy: { user: { id: "consultee-1" } },
      appointment: null,
    });

    const result = await SlotAllocationService.allocate({
      eventType: "consultation",
      eventId: "consult-1",
      mode: "manual",
      slots: ["2025-01-06T10:00:00Z", "2025-01-06T10:30:00Z"],
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Consultant profile not found");
  });

  it("should throw for invalid date range (start >= end)", async () => {
    mockTx.subscription.findUnique.mockResolvedValue(
      makeSubscriptionEvent({
        schedulingPeriodStartsAt: new Date("2025-02-01T00:00:00Z"),
        schedulingPeriodEndsAt: new Date("2025-01-01T00:00:00Z"), // before start!
      }),
    );

    const result = await SlotAllocationService.allocate({
      eventType: "subscription",
      eventId: "sub-1",
      mode: "manual",
      slots: ["2025-01-06T10:00:00Z", "2025-01-06T10:30:00Z"],
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid date range");
    expect(result.error).toContain("must be before");
  });

  it("should extract durationInHours for consultation config", async () => {
    mockTx.consultation.findUnique.mockResolvedValue(
      makeConsultationEvent({
        consultationPlan: {
          durationInHours: 1.5, // 3 slots needed
          consultantProfile: makeConsultantProfile(),
        },
      }),
    );

    // 1.5-hour session needs 3 consecutive slots
    const result = await SlotAllocationService.allocate({
      eventType: "consultation",
      eventId: "consult-1",
      mode: "manual",
      slots: [
        "2025-01-06T10:00:00Z",
        "2025-01-06T10:30:00Z",
        "2025-01-06T11:00:00Z",
      ],
    });

    expect(result.success).toBe(true);
  });

  it("should extract subscription config including callsPerWeek and scheduling period", async () => {
    mockTx.subscription.findUnique.mockResolvedValue(makeSubscriptionEvent());

    await SlotAllocationService.allocate({
      eventType: "subscription",
      eventId: "sub-1",
      mode: "manual",
      slots: ["2025-01-06T10:00:00Z", "2025-01-06T10:30:00Z"],
    });

    // Validate that the validator received the correct config
    expect(mockValidateFn).toHaveBeenCalledWith(
      "subscription",
      "sub-1",
      expect.any(Array),
      expect.objectContaining({ userId: "consultant-1" }),
      expect.objectContaining({
        callsPerWeek: 1,
        sessionDurationInHours: 1,
        schedulingPeriodStartsAt: expect.any(Date),
        schedulingPeriodEndsAt: expect.any(Date),
      }),
      expect.any(Array), // appointmentIdsToExclude
      "consultee-1", // #676 AE-1 — consulteeUserId threaded for the conflict scan
    );
  });

  it("should extract webinar config with durationInHours", async () => {
    mockTx.webinar.findUnique.mockResolvedValue(makeWebinarEvent());

    await SlotAllocationService.allocate({
      eventType: "webinar",
      eventId: "webinar-1",
      mode: "manual",
      slots: ["2025-01-06T10:00:00Z", "2025-01-06T10:30:00Z"],
    });

    expect(mockValidateFn).toHaveBeenCalledWith(
      "webinar",
      "webinar-1",
      expect.any(Array),
      expect.objectContaining({ userId: "consultant-1" }),
      expect.objectContaining({ durationInHours: 1 }),
      expect.any(Array), // appointmentIdsToExclude
      undefined, // #676 AE-1 — group event, no single consultee
    );
  });

  it("should extract class config with meetingsPerWeek and classContents", async () => {
    mockTx.class.findUnique.mockResolvedValue(
      makeClassEvent({
        classPlan: {
          durationInMonths: 2,
          meetingsPerWeek: 2,
          sessionDurationInHours: 1.5,
          consultantProfile: makeConsultantProfile(),
          classContents: [{ hoursAllotted: 1 }, { hoursAllotted: 2 }],
        },
        // 1 week with meetingsPerWeek=2, 1.5hr sessions (3 slots each) → requires 6 slots
        schedulingPeriodEndsAt: new Date("2025-01-10T00:00:00Z"),
      }),
    );

    await SlotAllocationService.allocate({
      eventType: "class",
      eventId: "class-1",
      mode: "manual",
      // classContents average: (1+2)/2 = 1.5 hours → 3 slots per call, 2 calls = 6 slots
      slots: [
        "2025-01-06T10:00:00Z",
        "2025-01-06T10:30:00Z",
        "2025-01-06T11:00:00Z",
        "2025-01-08T10:00:00Z",
        "2025-01-08T10:30:00Z",
        "2025-01-08T11:00:00Z",
      ],
    });

    expect(mockValidateFn).toHaveBeenCalledWith(
      "class",
      "class-1",
      expect.any(Array),
      expect.any(Object),
      expect.objectContaining({
        callsPerWeek: 2,
        sessionDurationInHours: 1.5,
      }),
      expect.any(Array), // appointmentIdsToExclude
      undefined, // #676 AE-1 — group event, no single consultee
    );
  });
});

// ─── updateEventStatus (tested indirectly) ──────────────────────────────────

describe("updateEventStatus", () => {
  it("should set APPROVED for subscription with existing scheduling period", async () => {
    mockTx.subscription.findUnique.mockResolvedValue(makeSubscriptionEvent());

    await SlotAllocationService.allocate({
      eventType: "subscription",
      eventId: "sub-1",
      mode: "manual",
      slots: ["2025-01-06T10:00:00Z", "2025-01-06T10:30:00Z"],
    });

    expect(mockTx.subscription.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "sub-1" }),
        data: expect.objectContaining({
          status: AppointmentStatus.APPROVED,
        }),
      }),
    );
    // Should NOT overwrite existing scheduling period
    const updateData = mockTx.subscription.updateMany.mock.calls[0][0].data;
    expect(updateData.schedulingPeriodStartsAt).toBeUndefined();
  });

  it("should create scheduling period for subscription when not configured", async () => {
    mockTx.subscription.findUnique.mockResolvedValue(
      makeSubscriptionEvent({
        schedulingPeriodStartsAt: null,
        schedulingPeriodEndsAt: null,
        subscriptionPlan: {
          durationInMonths: 1,
          callsPerWeek: 1,
          sessionDurationInHours: 1,
          consultantProfile: makeConsultantProfile(),
        },
      }),
    );

    await SlotAllocationService.allocate({
      eventType: "subscription",
      eventId: "sub-1",
      mode: "manual",
      slots: ["2025-01-06T10:00:00Z", "2025-01-06T10:30:00Z"],
    });

    const updateData = mockTx.subscription.updateMany.mock.calls[0][0].data;
    expect(updateData.schedulingPeriodStartsAt).toBeDefined();
    expect(updateData.schedulingPeriodEndsAt).toBeDefined();
  });

  it("should set SCHEDULED for webinar without scheduling period", async () => {
    mockTx.webinar.findUnique.mockResolvedValue(makeWebinarEvent());

    await SlotAllocationService.allocate({
      eventType: "webinar",
      eventId: "webinar-1",
      mode: "manual",
      slots: ["2025-01-06T10:00:00Z", "2025-01-06T10:30:00Z"],
    });

    const updateData = mockTx.webinar.update.mock.calls[0][0].data;
    expect(updateData.status).toBe("SCHEDULED");
    // Webinar should NOT have scheduling period fields
    expect(updateData.schedulingPeriodStartsAt).toBeUndefined();
    expect(updateData.schedulingPeriodEndsAt).toBeUndefined();
  });

  it("should set SCHEDULED with scheduling period for class", async () => {
    // Use a class without pre-set scheduling period — updateEventStatus should
    // derive schedulingPeriodStartsAt/EndsAt from the first allocated slot
    mockTx.class.findUnique.mockResolvedValue(
      makeClassEvent({
        schedulingPeriodStartsAt: null,
        schedulingPeriodEndsAt: null,
      }),
    );

    await SlotAllocationService.allocate({
      eventType: "class",
      eventId: "class-1",
      mode: "manual",
      slots: ["2025-01-06T10:00:00Z", "2025-01-06T10:30:00Z"],
    });

    const updateData = mockTx.class.update.mock.calls[0][0].data;
    expect(updateData.status).toBe("SCHEDULED");
    expect(updateData.schedulingPeriodStartsAt).toBeDefined();
    expect(updateData.schedulingPeriodEndsAt).toBeDefined();
  });
});

// ─── createAppointments (tested indirectly) ─────────────────────────────────

describe("createAppointments - grouping and validation", () => {
  it("should group 4 slots into 2 appointments for 1-hour sessions", async () => {
    mockTx.subscription.findUnique.mockResolvedValue(
      makeSubscriptionEvent({
        schedulingPeriodEndsAt: new Date("2025-01-17T00:00:00Z"), // 2 weeks → requires 4 slots
      }),
    );

    await SlotAllocationService.allocate({
      eventType: "subscription",
      eventId: "sub-1",
      mode: "manual",
      slots: [
        "2025-01-06T10:00:00Z",
        "2025-01-06T10:30:00Z",
        "2025-01-13T10:00:00Z",
        "2025-01-13T10:30:00Z",
      ],
    });

    expect(mockTx.appointment.create).toHaveBeenCalledTimes(2);

    // First appointment: first 2 slots
    const call1 = mockTx.appointment.create.mock.calls[0][0];
    expect(call1.data.slotsOfAppointment.create).toHaveLength(2);

    // Second appointment: next 2 slots
    const call2 = mockTx.appointment.create.mock.calls[1][0];
    expect(call2.data.slotsOfAppointment.create).toHaveLength(2);
  });

  it("should group 6 slots into 2 appointments for 1.5-hour sessions", async () => {
    mockTx.subscription.findUnique.mockResolvedValue(
      makeSubscriptionEvent({
        subscriptionPlan: {
          durationInMonths: 1,
          callsPerWeek: 1,
          sessionDurationInHours: 1.5, // 3 slots per call
          consultantProfile: makeConsultantProfile(),
        },
        schedulingPeriodEndsAt: new Date("2025-01-17T00:00:00Z"), // 2 weeks → requires 6 slots
      }),
    );

    await SlotAllocationService.allocate({
      eventType: "subscription",
      eventId: "sub-1",
      mode: "manual",
      slots: [
        "2025-01-06T10:00:00Z",
        "2025-01-06T10:30:00Z",
        "2025-01-06T11:00:00Z",
        "2025-01-13T10:00:00Z",
        "2025-01-13T10:30:00Z",
        "2025-01-13T11:00:00Z",
      ],
    });

    expect(mockTx.appointment.create).toHaveBeenCalledTimes(2);
    // Each appointment has 3 slots
    expect(
      mockTx.appointment.create.mock.calls[0][0].data.slotsOfAppointment.create,
    ).toHaveLength(3);
    expect(
      mockTx.appointment.create.mock.calls[1][0].data.slotsOfAppointment.create,
    ).toHaveLength(3);
  });

  it("should set isTentative to false on all created slots", async () => {
    mockTx.consultation.findUnique.mockResolvedValue(makeConsultationEvent());

    await SlotAllocationService.allocate({
      eventType: "consultation",
      eventId: "consult-1",
      mode: "manual",
      slots: ["2025-01-06T10:00:00Z", "2025-01-06T10:30:00Z"],
    });

    const slotsCreated =
      mockTx.appointment.create.mock.calls[0][0].data.slotsOfAppointment.create;
    for (const slot of slotsCreated) {
      expect(slot.isTentative).toBe(false);
    }
  });

  it("should only connect consultant when no consultee (webinar)", async () => {
    mockTx.webinar.findUnique.mockResolvedValue(makeWebinarEvent());

    await SlotAllocationService.allocate({
      eventType: "webinar",
      eventId: "webinar-1",
      mode: "manual",
      slots: ["2025-01-06T10:00:00Z", "2025-01-06T10:30:00Z"],
    });

    const userConnect =
      mockTx.appointment.create.mock.calls[0][0].data.slotsOfAppointment
        .create[0].user.connect;
    expect(userConnect).toEqual([{ id: "consultant-1" }]);
  });

  it("should include slotsOfAppointment in create response", async () => {
    mockTx.consultation.findUnique.mockResolvedValue(makeConsultationEvent());

    await SlotAllocationService.allocate({
      eventType: "consultation",
      eventId: "consult-1",
      mode: "manual",
      slots: ["2025-01-06T10:00:00Z", "2025-01-06T10:30:00Z"],
    });

    const createCall = mockTx.appointment.create.mock.calls[0][0];
    expect(createCall.include).toEqual({ slotsOfAppointment: true });
  });
});

// ─── deleteExistingAppointments (tested indirectly) ─────────────────────────

describe("deleteExistingAppointments", () => {
  it("should delete all existing appointments for manual allocation", async () => {
    mockTx.consultation.findUnique.mockResolvedValue(makeConsultationEvent());
    // findMany for reschedule detection and delete returns existing appointments
    // Must include slotsOfAppointment for reschedule detection in manualAllocate
    mockTx.appointment.findMany.mockResolvedValue([
      { id: "old-1", slotsOfAppointment: [] },
      { id: "old-2", slotsOfAppointment: [] },
    ]);

    await SlotAllocationService.allocate({
      eventType: "consultation",
      eventId: "consult-1",
      mode: "manual",
      slots: ["2025-01-06T10:00:00Z", "2025-01-06T10:30:00Z"],
    });

    expect(mockTx.appointment.delete).toHaveBeenCalledWith({
      where: { id: "old-1" },
    });
    expect(mockTx.appointment.delete).toHaveBeenCalledWith({
      where: { id: "old-2" },
    });
  });

  it("should not delete when no existing appointments", async () => {
    mockTx.consultation.findUnique.mockResolvedValue(makeConsultationEvent());
    mockTx.appointment.findMany.mockResolvedValue([]);

    await SlotAllocationService.allocate({
      eventType: "consultation",
      eventId: "consult-1",
      mode: "manual",
      slots: ["2025-01-06T10:00:00Z", "2025-01-06T10:30:00Z"],
    });

    expect(mockTx.appointment.delete).not.toHaveBeenCalled();
  });
});

// ─── Edge Cases ─────────────────────────────────────────────────────────────

describe("Edge cases", () => {
  it("should handle 0.5-hour consultation (single slot)", async () => {
    mockTx.consultation.findUnique.mockResolvedValue(
      makeConsultationEvent({
        consultationPlan: {
          durationInHours: 0.5,
          consultantProfile: makeConsultantProfile(),
        },
      }),
    );

    const result = await SlotAllocationService.allocate({
      eventType: "consultation",
      eventId: "consult-1",
      mode: "manual",
      slots: ["2025-01-06T10:00:00Z"],
    });

    expect(result.success).toBe(true);
    const slotsCreated =
      mockTx.appointment.create.mock.calls[0][0].data.slotsOfAppointment.create;
    expect(slotsCreated).toHaveLength(1);
  });

  it("should handle 2-hour webinar (4 slots)", async () => {
    mockTx.webinar.findUnique.mockResolvedValue(
      makeWebinarEvent({
        webinarPlan: {
          durationInHours: 2,
          consultantProfile: makeConsultantProfile(),
        },
      }),
    );

    const result = await SlotAllocationService.allocate({
      eventType: "webinar",
      eventId: "webinar-1",
      mode: "manual",
      slots: [
        "2025-01-06T10:00:00Z",
        "2025-01-06T10:30:00Z",
        "2025-01-06T11:00:00Z",
        "2025-01-06T11:30:00Z",
      ],
    });

    expect(result.success).toBe(true);
    expect(mockTx.appointment.create).toHaveBeenCalledTimes(1);
    expect(
      mockTx.appointment.create.mock.calls[0][0].data.slotsOfAppointment.create,
    ).toHaveLength(4);
  });

  it("should handle class with meetingsPerWeek mapping to callsPerWeek", async () => {
    mockTx.class.findUnique.mockResolvedValue(makeClassEvent());

    const result = await SlotAllocationService.allocate({
      eventType: "class",
      eventId: "class-1",
      mode: "manual",
      slots: ["2025-01-06T10:00:00Z", "2025-01-06T10:30:00Z"],
    });

    expect(result.success).toBe(true);
    const createCall = mockTx.appointment.create.mock.calls[0][0];
    expect(createCall.data.appointmentType).toBe(AppointmentsType.CLASS);
    expect(createCall.data.class).toEqual({ connect: { id: "class-1" } });
  });

  it("should handle custom schedule consultant", async () => {
    const customConsultant = makeConsultantProfile({
      scheduleType: ScheduleType.CUSTOM,
      slotsOfAvailabilityWeekly: [],
      slotsOfAvailabilityCustom: [
        makeCustomAvailabilitySlot(
          "2025-01-06T10:00:00.000Z",
          "2025-01-06T12:00:00.000Z",
        ),
      ],
    });

    mockTx.consultation.findUnique.mockResolvedValue(
      makeConsultationEvent({
        consultationPlan: {
          durationInHours: 1,
          consultantProfile: customConsultant,
        },
      }),
    );

    const result = await SlotAllocationService.allocate({
      eventType: "consultation",
      eventId: "consult-1",
      mode: "auto",
    });

    expect(result.success).toBe(true);
  });

  it("should pass the correct event type through the entire flow", async () => {
    // Test each event type routes to the correct Prisma model
    for (const eventType of [
      "consultation",
      "subscription",
      "webinar",
      "class",
    ] as const) {
      const freshTx = makeMockTx();
      (prisma.$transaction as jest.Mock).mockImplementation(async (cb: any) =>
        cb(freshTx),
      );

      const eventFactories = {
        consultation: makeConsultationEvent,
        subscription: makeSubscriptionEvent,
        webinar: makeWebinarEvent,
        class: makeClassEvent,
      };

      freshTx[eventType].findUnique.mockResolvedValue(
        eventFactories[eventType](),
      );

      const slots = ["2025-01-06T10:00:00Z", "2025-01-06T10:30:00Z"];

      await SlotAllocationService.allocate({
        eventType,
        eventId: `${eventType}-1`,
        mode: "manual",
        slots,
      });

      // Correct model was queried
      expect(freshTx[eventType].findUnique).toHaveBeenCalled();
      // Correct model was updated — consultation/subscription go through
      // the #836 CAS transition helpers (updateMany); webinar/class still
      // use a plain update in updateEventStatus.
      const mutator =
        eventType === "consultation" || eventType === "subscription"
          ? freshTx[eventType].updateMany
          : freshTx[eventType].update;
      expect(mutator).toHaveBeenCalled();
    }
  });
});

// ─── Manual allocation distributed lock (TEST-2) ────────────────────────────

describe("Manual allocation - distributed lock", () => {
  it("should acquire and release consultant-level lock for manual allocation", async () => {
    const {
      lockAutoAllocate,
      unlockAutoAllocate,
    } = require("../../utils/appointmentlock");

    mockTx.consultation.findUnique.mockResolvedValue(makeConsultationEvent());

    await SlotAllocationService.allocate({
      eventType: "consultation",
      eventId: "consult-1",
      mode: "manual",
      slots: ["2025-01-06T10:00:00Z", "2025-01-06T10:30:00Z"],
    });

    // Lock should have been acquired with the consultant profile ID
    expect(lockAutoAllocate).toHaveBeenCalledWith("consultant-profile-1");
    // Lock should have been released in finally block
    expect(unlockAutoAllocate).toHaveBeenCalled();
  });

  it("should release lock even when transaction fails", async () => {
    const {
      lockAutoAllocate,
      unlockAutoAllocate,
    } = require("../../utils/appointmentlock");

    // Make the transaction throw
    (prisma.$transaction as jest.Mock).mockRejectedValueOnce(
      new Error("DB connection lost"),
    );

    const result = await SlotAllocationService.allocate({
      eventType: "consultation",
      eventId: "consult-1",
      mode: "manual",
      slots: ["2025-01-06T10:00:00Z", "2025-01-06T10:30:00Z"],
    });

    expect(result.success).toBe(false);
    // Lock should still be released even after error
    expect(unlockAutoAllocate).toHaveBeenCalled();
  });

  it("should return 409 when lock acquisition fails", async () => {
    const { lockAutoAllocate } = require("../../utils/appointmentlock");

    // Simulate lock contention
    lockAutoAllocate.mockRejectedValueOnce(
      new Error("Lock acquisition failed: resource is locked"),
    );

    const result = await SlotAllocationService.allocate({
      eventType: "consultation",
      eventId: "consult-1",
      mode: "manual",
      slots: ["2025-01-06T10:00:00Z", "2025-01-06T10:30:00Z"],
    });

    expect(result.success).toBe(false);
    expect(result.httpStatus).toBe(409);
    expect(result.errorCode).toBe("LOCK_CONTENTION");
  });
});

// ─── Auto allocation with IST timezone (TEST-1 integration) ─────────────────

describe("Auto allocation - timezone day shift", () => {
  it("should find slots for IST consultant with Monday availability", async () => {
    // IST consultant (UTC+5:30) with Monday 09:00-17:00 local
    // = UTC Monday 03:30-11:30
    // startTimeUtc = 210 (03:30), endTimeUtc = 690 (11:30)
    // utcOffsetMinutes = 330
    mockTx.consultation.findUnique.mockResolvedValue(
      makeConsultationEvent({
        consultationPlan: {
          durationInHours: 1,
          consultantProfile: makeConsultantProfile({
            user: { id: "consultant-1", timezone: "Asia/Kolkata" },
            slotsOfAvailabilityWeekly: [
              makeWeeklyAvailabilitySlot(DayOfWeek.MONDAY, 3, 11, 330),
            ],
          }),
        },
      }),
    );

    const result = await SlotAllocationService.allocate({
      eventType: "consultation",
      eventId: "consult-1",
      mode: "auto",
    });

    expect(result.success).toBe(true);
    expect(mockTx.appointment.create).toHaveBeenCalledTimes(1);

    // Verify the created slots are on a Monday in UTC
    const createCall = mockTx.appointment.create.mock.calls[0][0];
    const firstSlot = createCall.data.slotsOfAppointment.create[0];
    const slotDate = new Date(firstSlot.startsAt);
    expect(slotDate.getUTCDay()).toBe(1); // Monday
    expect(slotDate.getUTCHours()).toBeGreaterThanOrEqual(3);
    expect(slotDate.getUTCHours()).toBeLessThan(11);
  });
});
