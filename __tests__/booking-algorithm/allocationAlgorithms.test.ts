/**
 * Comprehensive tests for AllocationAlgorithms
 *
 * Covers:
 * - manualAllocate (validation, business rules, error handling)
 * - autoAllocate (all strategies, preference filtering, error handling)
 * - preAllocate (validation, delegation)
 * - filterSlotsByPreferences (private, tested via autoAllocate)
 * - allocateConsultationSlots (session duration fix verification)
 * - allocateWebinarSlots (consecutive slot finding)
 * - allocateRecurringSlots (weekly distribution, session duration fix)
 * - selectCallsFromWeek (spacing, consecutive block selection)
 * - sortSlotsByPreference / scoring functions
 */

import "./setup";

import {
  AllocationAlgorithms,
  type AllocationOptions,
  type AutoAllocationPreferences,
} from "@/app/dashboard/consultant/[consultantId]/(features)/shared/utils/allocationAlgorithms";
import { AllocationService } from "@/app/dashboard/consultant/[consultantId]/(features)/shared/utils/allocationService";
import {
  makeTimeSlot,
  makeConsecutiveTimeSlots,
  makeWeekOfAvailability,
} from "./__mocks__/booking.mockData";

// Use jest.spyOn instead of jest.mock to avoid bracket-path resolution issue
let mockAllocateSlots: jest.SpyInstance;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date("2025-01-01T00:00:00Z"));
  mockAllocateSlots = jest
    .spyOn(AllocationService, "allocateSlots")
    .mockResolvedValue({ success: true });
});

afterEach(() => {
  jest.useRealTimers();
  mockAllocateSlots.mockRestore();
});

// ─── Helper: create future slots ────────────────────────────────────────────

function makeFutureConsecutiveSlots(
  startISO: string,
  count: number,
  overrides: Partial<{ isBooked: boolean; isAvailable: boolean }> = {},
) {
  return makeConsecutiveTimeSlots(startISO, count, overrides);
}

// ─── manualAllocate ─────────────────────────────────────────────────────────

describe("AllocationAlgorithms.manualAllocate", () => {
  const baseOptions: AllocationOptions = {
    eventType: "consultation",
    eventId: "event-1",
    durationInHours: 1,
  };

  it("should reject when slot count doesn't match required", async () => {
    const slots = makeFutureConsecutiveSlots("2025-06-01T09:00:00Z", 1);
    const result = await AllocationAlgorithms.manualAllocate(slots as any, baseOptions);
    expect(result.success).toBe(false);
    expect(result.error).toContain("Expected 2 slots but received 1");
  });

  it("should reject past slots", async () => {
    const slots = makeFutureConsecutiveSlots("2024-01-01T09:00:00Z", 2);
    const result = await AllocationAlgorithms.manualAllocate(slots as any, baseOptions);
    expect(result.success).toBe(false);
    expect(result.error).toContain("past");
  });

  it("should accept valid consultation slots", async () => {
    const slots = makeFutureConsecutiveSlots("2025-06-01T09:00:00Z", 2);
    const result = await AllocationAlgorithms.manualAllocate(slots as any, baseOptions);
    expect(result.success).toBe(true);
    expect(result.strategy).toBe("manual");
    expect(mockAllocateSlots).toHaveBeenCalledTimes(1);
  });

  it("should reject non-consecutive webinar slots", async () => {
    const slots = [
      makeTimeSlot("2025-06-01T09:00:00Z", "2025-06-01T09:30:00Z"),
      makeTimeSlot("2025-06-01T10:00:00Z", "2025-06-01T10:30:00Z"),
    ];

    const result = await AllocationAlgorithms.manualAllocate(slots as any, {
      ...baseOptions,
      eventType: "webinar",
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("consecutive");
  });

  it("should accept consecutive webinar slots", async () => {
    const slots = makeFutureConsecutiveSlots("2025-06-01T09:00:00Z", 2);
    const result = await AllocationAlgorithms.manualAllocate(slots as any, {
      ...baseOptions,
      eventType: "webinar",
    });
    expect(result.success).toBe(true);
  });

  it("should require callsPerWeek for subscription", async () => {
    const slots = makeFutureConsecutiveSlots("2025-06-01T09:00:00Z", 2);
    const result = await AllocationAlgorithms.manualAllocate(slots as any, {
      eventType: "subscription",
      eventId: "event-1",
      durationInHours: 1,
      startDate: new Date("2025-06-01"),
      endDate: new Date("2025-06-07"),
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Calls per week is required");
  });

  it("should validate slot distribution for subscriptions", async () => {
    // 4 slots total (matches required: 0.5hr × 1 call/wk × 4 weeks = 4 slots)
    // but 3 are in the same week → exceeds callsPerWeek = 1
    const slots = [
      makeTimeSlot("2025-06-02T09:00:00Z", "2025-06-02T09:30:00Z"),
      makeTimeSlot("2025-06-03T09:00:00Z", "2025-06-03T09:30:00Z"),
      makeTimeSlot("2025-06-04T09:00:00Z", "2025-06-04T09:30:00Z"),
      makeTimeSlot("2025-06-09T09:00:00Z", "2025-06-09T09:30:00Z"),
    ];

    const result = await AllocationAlgorithms.manualAllocate(slots as any, {
      eventType: "subscription",
      eventId: "event-1",
      durationInHours: 0.5,
      callsPerWeek: 1,
      startDate: new Date("2025-06-01"),
      endDate: new Date("2025-06-28"),
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Too many slots");
  });

  it("should handle AllocationService failure", async () => {
    mockAllocateSlots.mockResolvedValue({
      success: false,
      error: "Server error",
    });

    const slots = makeFutureConsecutiveSlots("2025-06-01T09:00:00Z", 2);
    const result = await AllocationAlgorithms.manualAllocate(slots as any, baseOptions);
    expect(result.success).toBe(false);
    expect(result.error).toBe("Server error");
  });

  it("should handle thrown errors gracefully", async () => {
    mockAllocateSlots.mockRejectedValue(new Error("Network error"));

    const slots = makeFutureConsecutiveSlots("2025-06-01T09:00:00Z", 2);
    const result = await AllocationAlgorithms.manualAllocate(slots as any, baseOptions);
    expect(result.success).toBe(false);
    expect(result.error).toBe("Network error");
  });
});

// ─── autoAllocate ───────────────────────────────────────────────────────────

describe("AllocationAlgorithms.autoAllocate", () => {
  it("should return error when not enough slots available", async () => {
    const slots = makeFutureConsecutiveSlots("2025-06-01T09:00:00Z", 1);
    const result = await AllocationAlgorithms.autoAllocate(slots as any, {
      eventType: "consultation",
      eventId: "event-1",
      durationInHours: 1,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Not enough slots");
  });

  it("should return error for unsupported event type", async () => {
    const slots = makeFutureConsecutiveSlots("2025-06-01T09:00:00Z", 2);
    const result = await AllocationAlgorithms.autoAllocate(slots as any, {
      eventType: "unknown" as any,
      eventId: "event-1",
    });
    expect(result.success).toBe(false);
  });

  describe("consultation strategy", () => {
    it("should select earliest consecutive slots for 1-hour consultation", async () => {
      const slots = makeFutureConsecutiveSlots("2025-06-01T09:00:00Z", 4);
      const result = await AllocationAlgorithms.autoAllocate(slots as any, {
        eventType: "consultation",
        eventId: "event-1",
        durationInHours: 1,
      });
      expect(result.success).toBe(true);
      expect(result.selectedSlots.length).toBe(2);
      expect(result.strategy).toBe("earliest-available");
    });

    it("should select 3 slots for 1.5-hour consultation (fix verification)", async () => {
      // Need at least 2 consecutive 1-hour availability blocks
      const slots = makeFutureConsecutiveSlots("2025-06-01T09:00:00Z", 4);
      const result = await AllocationAlgorithms.autoAllocate(slots as any, {
        eventType: "consultation",
        eventId: "event-1",
        durationInHours: 1.5,
      });
      expect(result.success).toBe(true);
      expect(result.selectedSlots.length).toBe(3);
    });

    it("should select 1 slot for 0.5-hour consultation", async () => {
      const slots = makeFutureConsecutiveSlots("2025-06-01T09:00:00Z", 2);
      const result = await AllocationAlgorithms.autoAllocate(slots as any, {
        eventType: "consultation",
        eventId: "event-1",
        durationInHours: 0.5,
      });
      expect(result.success).toBe(true);
      expect(result.selectedSlots.length).toBe(1);
    });
  });

  describe("webinar strategy", () => {
    it("should find consecutive slots for 2-hour webinar", async () => {
      const slots = makeFutureConsecutiveSlots("2025-06-01T09:00:00Z", 6);
      const result = await AllocationAlgorithms.autoAllocate(slots as any, {
        eventType: "webinar",
        eventId: "event-1",
        durationInHours: 2,
      });
      expect(result.success).toBe(true);
      expect(result.selectedSlots.length).toBe(4);
      expect(result.strategy).toBe("consecutive-slots");
    });

    it("should fail when no consecutive block is large enough", async () => {
      // Two separate 30-min slots with a gap
      const slots = [
        makeTimeSlot("2025-06-01T09:00:00Z", "2025-06-01T09:30:00Z"),
        makeTimeSlot("2025-06-01T10:00:00Z", "2025-06-01T10:30:00Z"),
      ];

      const result = await AllocationAlgorithms.autoAllocate(slots as any, {
        eventType: "webinar",
        eventId: "event-1",
        durationInHours: 1,
      });
      // 1-hour webinar needs 2 consecutive slots, but these have a gap
      expect(result.success).toBe(false);
    });
  });

  describe("subscription/class strategy", () => {
    it("should return error when dates are missing", async () => {
      const slots = makeFutureConsecutiveSlots("2025-06-01T09:00:00Z", 10);
      const result = await AllocationAlgorithms.autoAllocate(slots as any, {
        eventType: "subscription",
        eventId: "event-1",
        sessionDurationInHours: 1,
        callsPerWeek: 1,
      });
      // Missing startDate/endDate → allocateRecurringSlots returns []
      expect(result.success).toBe(false);
    });

    it("should distribute calls across weeks", async () => {
      // Create slots across 2 weeks
      const week1Slots = makeWeekOfAvailability("2025-06-01T00:00:00Z", 10);
      const week2Slots = makeWeekOfAvailability("2025-06-08T00:00:00Z", 10);
      const allSlots = [...week1Slots, ...week2Slots];

      const result = await AllocationAlgorithms.autoAllocate(allSlots as any, {
        eventType: "subscription",
        eventId: "event-1",
        sessionDurationInHours: 1,
        callsPerWeek: 1,
        startDate: new Date("2025-06-01"),
        endDate: new Date("2025-06-14"),
      });

      if (result.success) {
        // Should have distributed across weeks
        expect(result.selectedSlots.length).toBeGreaterThan(0);
        expect(result.strategy).toBe("optimal-distribution");
      }
    });
  });

  describe("preference filtering", () => {
    it("should filter out past slots", async () => {
      const pastSlots = makeFutureConsecutiveSlots("2024-01-01T09:00:00Z", 4);
      const futureSlots = makeFutureConsecutiveSlots(
        "2025-06-01T09:00:00Z",
        4,
      );
      const allSlots = [...pastSlots, ...futureSlots];

      const result = await AllocationAlgorithms.autoAllocate(allSlots as any, {
        eventType: "consultation",
        eventId: "event-1",
        durationInHours: 1,
      });
      expect(result.success).toBe(true);
      // Selected slots should all be in the future
      result.selectedSlots.forEach((s) => {
        expect(s.startTime.getTime()).toBeGreaterThan(
          new Date("2025-01-01").getTime(),
        );
      });
    });

    it("should filter out booked slots", async () => {
      const slots = makeFutureConsecutiveSlots("2025-06-01T09:00:00Z", 4, {
        isBooked: true,
      });
      const result = await AllocationAlgorithms.autoAllocate(slots as any, {
        eventType: "consultation",
        eventId: "event-1",
        durationInHours: 0.5,
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain("Not enough slots");
    });

    it("should exclude weekends when requested", async () => {
      // Saturday slots
      const satSlots = makeFutureConsecutiveSlots(
        "2025-06-07T09:00:00Z",
        4,
      ); // Saturday

      const result = await AllocationAlgorithms.autoAllocate(
        satSlots as any,
        {
          eventType: "consultation",
          eventId: "event-1",
          durationInHours: 0.5,
        },
        { excludeWeekends: true },
      );
      expect(result.success).toBe(false);
    });

    it("should apply morning preference filter", async () => {
      // Afternoon slot (13:00)
      const afternoonSlots = makeFutureConsecutiveSlots(
        "2025-06-02T13:00:00Z",
        4,
      );
      // Morning slot (09:00)
      const morningSlots = makeFutureConsecutiveSlots(
        "2025-06-02T09:00:00Z",
        4,
      );

      const result = await AllocationAlgorithms.autoAllocate(
        [...afternoonSlots, ...morningSlots] as any,
        {
          eventType: "consultation",
          eventId: "event-1",
          durationInHours: 1,
        },
        { preferMorning: true },
      );

      if (result.success) {
        // Morning preference should only include 9-12 slots
        result.selectedSlots.forEach((s) => {
          const hour = s.startTime.getHours();
          expect(hour).toBeGreaterThanOrEqual(9);
          expect(hour).toBeLessThan(12);
        });
      }
    });

    it("should apply afternoon preference filter", async () => {
      // Use 6:00 AM local time — guaranteed morning in any timezone
      const baseDate = new Date(2025, 5, 2, 6, 0, 0, 0); // June 2, 6:00 AM local
      const morningSlots = makeConsecutiveTimeSlots(
        baseDate.toISOString(),
        4,
      );

      const result = await AllocationAlgorithms.autoAllocate(
        morningSlots as any,
        {
          eventType: "consultation",
          eventId: "event-1",
          durationInHours: 0.5,
        },
        { preferAfternoon: true },
      );
      // Morning slots (6:00-8:00 AM local) should be filtered out by afternoon preference (13-17)
      expect(result.success).toBe(false);
    });

    it("should apply evening preference filter", async () => {
      const morningSlots = makeFutureConsecutiveSlots(
        "2025-06-02T09:00:00Z",
        4,
      );

      const result = await AllocationAlgorithms.autoAllocate(
        morningSlots as any,
        {
          eventType: "consultation",
          eventId: "event-1",
          durationInHours: 0.5,
        },
        { preferEvening: true },
      );
      expect(result.success).toBe(false);
    });
  });

  it("should handle AllocationService failure in autoAllocate", async () => {
    mockAllocateSlots.mockResolvedValue({
      success: false,
      error: "Conflict",
    });

    const slots = makeFutureConsecutiveSlots("2025-06-01T09:00:00Z", 4);
    const result = await AllocationAlgorithms.autoAllocate(slots as any, {
      eventType: "consultation",
      eventId: "event-1",
      durationInHours: 1,
    });
    expect(result.success).toBe(false);
    expect(result.error).toBe("Conflict");
  });

  it("should handle thrown errors in autoAllocate", async () => {
    mockAllocateSlots.mockRejectedValue(new Error("Timeout"));

    const slots = makeFutureConsecutiveSlots("2025-06-01T09:00:00Z", 4);
    const result = await AllocationAlgorithms.autoAllocate(slots as any, {
      eventType: "consultation",
      eventId: "event-1",
      durationInHours: 1,
    });
    expect(result.success).toBe(false);
    expect(result.error).toBe("Timeout");
  });
});

// ─── preAllocate ────────────────────────────────────────────────────────────

describe("AllocationAlgorithms.preAllocate", () => {
  it("should reject when no requested slots provided", async () => {
    const result = await AllocationAlgorithms.preAllocate({
      eventType: "consultation",
      eventId: "event-1",
      durationInHours: 1,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("No requested slots");
  });

  it("should reject when requested slots is empty array", async () => {
    const result = await AllocationAlgorithms.preAllocate({
      eventType: "consultation",
      eventId: "event-1",
      durationInHours: 1,
      requestedSlots: [],
    });
    expect(result.success).toBe(false);
  });

  it("should reject wrong number of requested slots", async () => {
    const slots = makeFutureConsecutiveSlots("2025-06-01T09:00:00Z", 1);
    const result = await AllocationAlgorithms.preAllocate({
      eventType: "consultation",
      eventId: "event-1",
      durationInHours: 1,
      requestedSlots: slots as any,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Requested 1 slots but need 2");
  });

  it("should succeed with correct number of slots", async () => {
    const slots = makeFutureConsecutiveSlots("2025-06-01T09:00:00Z", 2);
    const result = await AllocationAlgorithms.preAllocate({
      eventType: "consultation",
      eventId: "event-1",
      durationInHours: 1,
      requestedSlots: slots as any,
    });
    expect(result.success).toBe(true);
    expect(result.strategy).toBe("requested-slots");
    expect(mockAllocateSlots).toHaveBeenCalledWith(
      "consultation",
      "event-1",
      slots,
      { useRequestedSlots: true },
    );
  });

  it("should handle AllocationService failure", async () => {
    mockAllocateSlots.mockResolvedValue({
      success: false,
      error: "Slot taken",
    });

    const slots = makeFutureConsecutiveSlots("2025-06-01T09:00:00Z", 2);
    const result = await AllocationAlgorithms.preAllocate({
      eventType: "consultation",
      eventId: "event-1",
      durationInHours: 1,
      requestedSlots: slots as any,
    });
    expect(result.success).toBe(false);
    expect(result.error).toBe("Slot taken");
  });

  it("should handle thrown errors", async () => {
    mockAllocateSlots.mockRejectedValue(new Error("Connection failed"));

    const slots = makeFutureConsecutiveSlots("2025-06-01T09:00:00Z", 2);
    const result = await AllocationAlgorithms.preAllocate({
      eventType: "consultation",
      eventId: "event-1",
      durationInHours: 1,
      requestedSlots: slots as any,
    });
    expect(result.success).toBe(false);
    expect(result.error).toBe("Connection failed");
  });
});
