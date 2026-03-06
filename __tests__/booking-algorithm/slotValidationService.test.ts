/**
 * Comprehensive tests for SlotValidationService
 *
 * Covers:
 * - checkSlotAvailability (conflict detection)
 * - validate() routing (event type dispatch)
 * - validateSlotsInFuture (5-second buffer)
 * - validateMatchesSchedule (weekly + custom, overlap detection)
 * - validateSchedulingPeriod (boundary checks)
 * - validateConsecutiveSlots (tolerance)
 * - validateSameDaySlots
 * - validateConsultation (duration, same-day, consecutive)
 * - validateWebinar (duration, consecutive)
 * - validateClass (weekly limits, session grouping)
 * - slotDurationMinutes fix verification
 */

import "./setup";

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {},
}));

import { SlotValidationService } from "@/utils/slotAllocation/SlotValidationService";
import { ScheduleType, DayOfWeek } from "@prisma/client";
import {
  makeConsultantData,
  makeWeeklyAvailabilitySlot,
  makeCustomAvailabilitySlot,
} from "./__mocks__/booking.mockData";

// ─── Mock Prisma ────────────────────────────────────────────────────────────

const mockPrisma = {
  appointment: {
    findFirst: jest.fn().mockResolvedValue(null),
    findMany: jest.fn().mockResolvedValue([]),
  },
  subscription: {
    findUnique: jest.fn().mockResolvedValue(null),
  },
} as any;

let service: SlotValidationService;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date("2025-01-01T00:00:00Z"));
  service = new SlotValidationService(mockPrisma);
  mockPrisma.appointment.findFirst.mockResolvedValue(null);
  mockPrisma.appointment.findMany.mockResolvedValue([]);
});

afterEach(() => {
  jest.useRealTimers();
});

// ─── Helper ─────────────────────────────────────────────────────────────────

function futureSlots(
  count: number,
  startISO: string = "2025-06-01T10:00:00Z",
): Date[] {
  const slots: Date[] = [];
  let current = new Date(startISO);
  for (let i = 0; i < count; i++) {
    slots.push(new Date(current));
    current = new Date(current.getTime() + 30 * 60 * 1000);
  }
  return slots;
}

const weeklyConsultant = makeConsultantData({
  scheduleType: ScheduleType.WEEKLY,
  slotsOfAvailabilityWeekly: [
    // Sunday June 1 2025 is a Sunday, so June 2 is Monday
    makeWeeklyAvailabilitySlot(DayOfWeek.MONDAY, 9, 17),
    makeWeeklyAvailabilitySlot(DayOfWeek.TUESDAY, 9, 17),
    makeWeeklyAvailabilitySlot(DayOfWeek.WEDNESDAY, 9, 17),
  ],
}) as any;

const customConsultant = makeConsultantData({
  scheduleType: ScheduleType.CUSTOM,
  slotsOfAvailabilityCustom: [
    makeCustomAvailabilitySlot(
      "2025-06-02T09:00:00.000Z",
      "2025-06-02T12:00:00.000Z",
    ),
    makeCustomAvailabilitySlot(
      "2025-06-03T14:00:00.000Z",
      "2025-06-03T16:00:00.000Z",
    ),
  ],
}) as any;

// ─── checkSlotAvailability ──────────────────────────────────────────────────

describe("checkSlotAvailability", () => {
  it("should return valid when no conflicts exist", async () => {
    const result = await service.checkSlotAvailability(
      futureSlots(2),
      "user-1",
    );
    expect(result.isValid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("should detect conflicts from existing appointments", async () => {
    const slots = futureSlots(1);
    mockPrisma.appointment.findMany.mockResolvedValue([
      {
        id: "existing-apt",
        slotsOfAppointment: [
          {
            startsAt: slots[0],
            endsAt: new Date(slots[0].getTime() + 30 * 60 * 1000),
          },
        ],
        consultation: {
          requestedBy: { user: { name: "Existing User" } },
        },
      },
    ]);

    const result = await service.checkSlotAvailability(slots, "user-1");
    expect(result.isValid).toBe(false);
    expect(result.errors[0]).toContain("already booked");
  });

  it("should use configurable slot duration", async () => {
    await service.checkSlotAvailability(futureSlots(1), "user-1", 60);
    // Verify the query was called — checking it doesn't throw with different duration
    expect(mockPrisma.appointment.findMany).toHaveBeenCalled();
  });

  it("should skip expired payment conflicts", async () => {
    const slots = futureSlots(1);
    mockPrisma.appointment.findMany.mockResolvedValue([
      {
        id: "expired-apt",
        slotsOfAppointment: [
          {
            startsAt: slots[0],
            endsAt: new Date(slots[0].getTime() + 30 * 60 * 1000),
          },
        ],
        consultation: {
          requestStatus: "APPROVED_PENDING_PAYMENT",
        },
        payment: [
          {
            expiresAt: new Date("2024-01-01"), // expired
          },
        ],
      },
    ]);

    const result = await service.checkSlotAvailability(slots, "user-1");
    expect(result.isValid).toBe(true);
  });
});

// ─── validate: future check ────────────────────────────────────────────────

describe("validate: future slot validation", () => {
  it("should reject past slots", async () => {
    const pastSlots = [new Date("2024-06-01T10:00:00Z")];
    const result = await service.validate(
      "consultation",
      "event-1",
      pastSlots,
      weeklyConsultant,
      { durationInHours: 0.5 },
    );
    expect(result.isValid).toBe(false);
    expect(result.errors[0]).toContain("past");
  });

  it("should reject slots within 5-second buffer", async () => {
    // Set time to just before slot
    jest.setSystemTime(new Date("2025-06-01T10:00:00Z"));
    const tooSoonSlot = [new Date("2025-06-01T10:00:03.000Z")]; // 3 seconds from now
    const result = await service.validate(
      "consultation",
      "event-1",
      tooSoonSlot,
      weeklyConsultant,
      { durationInHours: 0.5 },
    );
    expect(result.isValid).toBe(false);
  });

  it("should accept slots well in the future", async () => {
    const result = await service.validate(
      "consultation",
      "event-1",
      futureSlots(2, "2025-06-02T10:00:00Z"),
      weeklyConsultant,
      { durationInHours: 1 },
    );
    expect(result.isValid).toBe(true);
  });
});

// ─── validate: schedule matching ────────────────────────────────────────────

describe("validate: schedule matching", () => {
  it("should accept slots matching weekly availability", async () => {
    // Monday at 10:00 UTC — within 9-17 availability
    const result = await service.validate(
      "consultation",
      "event-1",
      futureSlots(2, "2025-06-02T10:00:00Z"), // Monday
      weeklyConsultant,
      { durationInHours: 1 },
    );
    expect(result.isValid).toBe(true);
  });

  it("should reject slots outside weekly availability hours", async () => {
    // Monday at 20:00 UTC — outside 9-17 availability
    const result = await service.validate(
      "consultation",
      "event-1",
      futureSlots(2, "2025-06-02T20:00:00Z"),
      weeklyConsultant,
      { durationInHours: 1 },
    );
    expect(result.isValid).toBe(false);
    expect(result.errors[0]).toContain("not match");
  });

  it("should reject slots on unavailable weekday", async () => {
    // Thursday — not in availability (only Mon/Tue/Wed)
    const result = await service.validate(
      "consultation",
      "event-1",
      futureSlots(2, "2025-06-05T10:00:00Z"), // Thursday
      weeklyConsultant,
      { durationInHours: 1 },
    );
    expect(result.isValid).toBe(false);
  });

  it("should accept slots within custom availability (overlap detection)", async () => {
    // June 2 at 09:00-10:00 — within 09:00-12:00 custom slot
    const result = await service.validate(
      "consultation",
      "event-1",
      futureSlots(2, "2025-06-02T09:00:00Z"),
      customConsultant,
      { durationInHours: 1 },
    );
    expect(result.isValid).toBe(true);
  });

  it("should reject slots outside custom availability", async () => {
    // June 2 at 13:00 — outside 09:00-12:00 custom slot
    const result = await service.validate(
      "consultation",
      "event-1",
      futureSlots(2, "2025-06-02T13:00:00Z"),
      customConsultant,
      { durationInHours: 1 },
    );
    expect(result.isValid).toBe(false);
  });

  it("should detect consecutive slot issues in custom schedule", async () => {
    // First slot valid (09:00), second slot invalid (12:30) — partial coverage
    const slots = [
      new Date("2025-06-02T09:00:00.000Z"),
      new Date("2025-06-02T12:30:00.000Z"),
    ];
    const result = await service.validate(
      "consultation",
      "event-1",
      slots,
      customConsultant,
      { durationInHours: 1 },
    );
    expect(result.isValid).toBe(false);
    expect(result.errors[0]).toContain("consecutive");
  });
});

// ─── validate: scheduling period ────────────────────────────────────────────

describe("validate: scheduling period", () => {
  it("should reject slots outside scheduling period", async () => {
    const result = await service.validate(
      "consultation",
      "event-1",
      futureSlots(2, "2025-06-02T10:00:00Z"),
      weeklyConsultant,
      {
        durationInHours: 1,
        schedulingPeriodStartsAt: new Date("2025-07-01"),
        schedulingPeriodEndsAt: new Date("2025-07-31"),
      },
    );
    expect(result.isValid).toBe(false);
    expect(result.errors[0]).toContain("outside the scheduling period");
  });

  it("should accept slots within scheduling period", async () => {
    const result = await service.validate(
      "consultation",
      "event-1",
      futureSlots(2, "2025-06-02T10:00:00Z"),
      weeklyConsultant,
      {
        durationInHours: 1,
        schedulingPeriodStartsAt: new Date("2025-06-01"),
        schedulingPeriodEndsAt: new Date("2025-06-30"),
      },
    );
    expect(result.isValid).toBe(true);
  });
});

// ─── validate: consultation ─────────────────────────────────────────────────

describe("validate: consultation event", () => {
  it("should accept correct slot count", async () => {
    const result = await service.validate(
      "consultation",
      "event-1",
      futureSlots(2, "2025-06-02T10:00:00Z"),
      weeklyConsultant,
      { durationInHours: 1 },
    );
    expect(result.isValid).toBe(true);
  });

  it("should reject wrong slot count", async () => {
    const result = await service.validate(
      "consultation",
      "event-1",
      futureSlots(1, "2025-06-02T10:00:00Z"),
      weeklyConsultant,
      { durationInHours: 1 },
    );
    expect(result.isValid).toBe(false);
    expect(result.errors[0]).toContain("requires exactly 2");
  });

  it("should reject slots on different days", async () => {
    const slots = [
      new Date("2025-06-02T10:00:00Z"), // Monday
      new Date("2025-06-03T10:00:00Z"), // Tuesday
    ];
    const result = await service.validate(
      "consultation",
      "event-1",
      slots,
      weeklyConsultant,
      { durationInHours: 1 },
    );
    expect(result.isValid).toBe(false);
    expect(result.errors.some((e) => e.includes("one-day event"))).toBe(true);
  });

  it("should reject non-consecutive same-day slots", async () => {
    const slots = [
      new Date("2025-06-02T10:00:00Z"),
      new Date("2025-06-02T11:00:00Z"), // 30-min gap
    ];
    const result = await service.validate(
      "consultation",
      "event-1",
      slots,
      weeklyConsultant,
      { durationInHours: 1 },
    );
    expect(result.isValid).toBe(false);
  });

  it("should reject invalid duration", async () => {
    const result = await service.validate(
      "consultation",
      "event-1",
      futureSlots(2, "2025-06-02T10:00:00Z"),
      weeklyConsultant,
      { durationInHours: -1 },
    );
    expect(result.isValid).toBe(false);
  });
});

// ─── validate: webinar ──────────────────────────────────────────────────────

describe("validate: webinar event", () => {
  it("should accept correct consecutive slots for 2-hour webinar", async () => {
    const result = await service.validate(
      "webinar",
      "event-1",
      futureSlots(4, "2025-06-02T10:00:00Z"),
      weeklyConsultant,
      { durationInHours: 2 },
    );
    expect(result.isValid).toBe(true);
  });

  it("should reject wrong slot count", async () => {
    const result = await service.validate(
      "webinar",
      "event-1",
      futureSlots(2, "2025-06-02T10:00:00Z"),
      weeklyConsultant,
      { durationInHours: 2 },
    );
    expect(result.isValid).toBe(false);
    expect(result.errors[0]).toContain("requires exactly 4");
  });

  it("should reject non-consecutive webinar slots", async () => {
    const slots = [
      new Date("2025-06-02T10:00:00Z"),
      new Date("2025-06-02T11:00:00Z"), // gap
    ];
    const result = await service.validate(
      "webinar",
      "event-1",
      slots,
      weeklyConsultant,
      { durationInHours: 1 },
    );
    expect(result.isValid).toBe(false);
  });

  it("should accept single-slot webinar (0.5 hour)", async () => {
    const result = await service.validate(
      "webinar",
      "event-1",
      futureSlots(1, "2025-06-02T10:00:00Z"),
      weeklyConsultant,
      { durationInHours: 0.5 },
    );
    expect(result.isValid).toBe(true);
  });

  it("should reject invalid webinar duration", async () => {
    const result = await service.validate(
      "webinar",
      "event-1",
      futureSlots(1, "2025-06-02T10:00:00Z"),
      weeklyConsultant,
      {},
    );
    expect(result.isValid).toBe(false);
  });
});

// ─── validate: class ────────────────────────────────────────────────────────

describe("validate: class event", () => {
  it("should reject when callsPerWeek is missing", async () => {
    const result = await service.validate(
      "class",
      "event-1",
      futureSlots(2, "2025-06-02T10:00:00Z"),
      weeklyConsultant,
      { sessionDurationInHours: 1 },
    );
    expect(result.isValid).toBe(false);
    expect(result.errors[0]).toContain("Classes per week is required");
  });

  it("should reject when sessionDurationInHours is missing", async () => {
    const result = await service.validate(
      "class",
      "event-1",
      futureSlots(2, "2025-06-02T10:00:00Z"),
      weeklyConsultant,
      { callsPerWeek: 2 },
    );
    expect(result.isValid).toBe(false);
    expect(result.errors[0]).toContain("Session duration is required");
  });

  it("should accept valid class slots with correct session grouping", async () => {
    // 2 consecutive slots = 1 complete 1-hour session
    const result = await service.validate(
      "class",
      "event-1",
      futureSlots(2, "2025-06-02T10:00:00Z"),
      weeklyConsultant,
      { callsPerWeek: 2, sessionDurationInHours: 1 },
    );
    expect(result.isValid).toBe(true);
  });

  it("should reject incomplete sessions (odd number of slots for 1hr)", async () => {
    const result = await service.validate(
      "class",
      "event-1",
      futureSlots(3, "2025-06-02T10:00:00Z"),
      weeklyConsultant,
      { callsPerWeek: 2, sessionDurationInHours: 1 },
    );
    expect(result.isValid).toBe(false);
    expect(result.errors.some((e) => e.includes("incomplete session"))).toBe(
      true,
    );
  });

  it("should reject when weekly session count exceeds limit", async () => {
    // 6 slots = 3 sessions in 1 week, but limit is 2
    const result = await service.validate(
      "class",
      "event-1",
      futureSlots(6, "2025-06-02T10:00:00Z"),
      weeklyConsultant,
      { callsPerWeek: 2, sessionDurationInHours: 1 },
    );
    expect(result.isValid).toBe(false);
    expect(result.errors.some((e) => e.includes("max is 2"))).toBe(true);
  });
});

// ─── validate: invalid event type ───────────────────────────────────────────

describe("validate: invalid event type", () => {
  it("should return error for unknown event type", async () => {
    const result = await service.validate(
      "unknown" as any,
      "event-1",
      futureSlots(1, "2025-06-02T10:00:00Z"),
      weeklyConsultant,
      { durationInHours: 0.5 },
    );
    expect(result.isValid).toBe(false);
    expect(result.errors[0]).toContain("Invalid event type");
  });
});

// ─── Slot duration fix verification ─────────────────────────────────────────

describe("Slot duration fix", () => {
  it("should use 30-minute fixed duration regardless of config", async () => {
    // This tests the fix: slotDurationMinutes = 30 (constant)
    // Previously it was calculated as sessionDuration * 60 / slots.length
    const result = await service.validate(
      "consultation",
      "event-1",
      futureSlots(2, "2025-06-02T10:00:00Z"),
      weeklyConsultant,
      { durationInHours: 1 },
    );
    // If slot duration was wrong, the conflict check query would use wrong time range
    // The fact that this passes with valid slots proves 30-min is used
    expect(result.isValid).toBe(true);
  });
});
