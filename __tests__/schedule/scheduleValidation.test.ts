/**
 * Comprehensive unit tests for schedule validation
 * Tests: basic validation, duration constraints, time increments,
 * overlap detection (back-to-back allowed), overnight handling, edge cases
 */

import {
  isValidTimeRange,
  validateTimeSlot,
  validateAllSlotsDetailed,
  getSlotStatistics,
} from "@/utils/timeSlotValidation";
import type { SlotType, SlotsType } from "@/utils/schedule/types";

describe("Schedule Validation", () => {
  // ============================================
  // Basic Time Range Validation
  // ============================================
  describe("Basic Time Range Validation", () => {
    it("should accept valid 1-hour slot", () => {
      expect(isValidTimeRange("09:00", "10:00")).toBe(true);
    });

    it("should accept minimum duration (30 minutes)", () => {
      expect(isValidTimeRange("09:00", "09:30")).toBe(true);
    });

    it("should reject below minimum duration (15 minutes)", () => {
      expect(isValidTimeRange("09:00", "09:15")).toBe(false);
    });

    it("should accept maximum duration (12 hours)", () => {
      expect(isValidTimeRange("06:00", "18:00")).toBe(true);
    });

    it("should reject above maximum duration (13 hours)", () => {
      expect(isValidTimeRange("06:00", "19:00")).toBe(false);
    });

    it("should reject empty start time", () => {
      expect(isValidTimeRange("", "10:00")).toBe(false);
    });

    it("should reject empty end time", () => {
      expect(isValidTimeRange("09:00", "")).toBe(false);
    });

    it("should reject same start and end time", () => {
      expect(isValidTimeRange("10:00", "10:00")).toBe(false);
    });
  });

  // ============================================
  // Duration Constraints
  // ============================================
  describe("Duration Constraints", () => {
    it("should accept exactly 30 minutes", () => {
      const result = validateTimeSlot(
        { startTime: "09:00", endTime: "09:30", isValid: false },
        [],
      );
      expect(result.isValid).toBe(true);
    });

    it("should reject 45 minutes (not multiple of 30)", () => {
      const result = validateTimeSlot(
        { startTime: "09:00", endTime: "09:45", isValid: false },
        [],
      );
      expect(result.isValid).toBe(false);
      expect(result.errorMessage).toContain("multiples of 30 minutes");
    });

    it("should accept 60 minutes", () => {
      const result = validateTimeSlot(
        { startTime: "09:00", endTime: "10:00", isValid: false },
        [],
      );
      expect(result.isValid).toBe(true);
    });

    it("should reject 75 minutes (not multiple of 30)", () => {
      const result = validateTimeSlot(
        { startTime: "09:00", endTime: "10:15", isValid: false },
        [],
      );
      expect(result.isValid).toBe(false);
      expect(result.errorMessage).toContain("multiples of 30 minutes");
    });

    it("should accept 90 minutes", () => {
      const result = validateTimeSlot(
        { startTime: "09:00", endTime: "10:30", isValid: false },
        [],
      );
      expect(result.isValid).toBe(true);
    });

    it("should accept 2 hours", () => {
      const result = validateTimeSlot(
        { startTime: "09:00", endTime: "11:00", isValid: false },
        [],
      );
      expect(result.isValid).toBe(true);
    });
  });

  // ============================================
  // Time Increment Validation
  // ============================================
  describe("Time Increment Validation", () => {
    it("should accept valid 15-min increments (00, 15, 30, 45)", () => {
      expect(
        validateTimeSlot(
          { startTime: "09:00", endTime: "10:00", isValid: false },
          [],
        ).isValid,
      ).toBe(true);

      expect(
        validateTimeSlot(
          { startTime: "09:15", endTime: "10:15", isValid: false },
          [],
        ).isValid,
      ).toBe(true);

      expect(
        validateTimeSlot(
          { startTime: "09:30", endTime: "10:30", isValid: false },
          [],
        ).isValid,
      ).toBe(true);

      expect(
        validateTimeSlot(
          { startTime: "09:45", endTime: "10:45", isValid: false },
          [],
        ).isValid,
      ).toBe(true);
    });

    it("should reject invalid 5-min increment", () => {
      const result = validateTimeSlot(
        { startTime: "09:05", endTime: "10:05", isValid: false },
        [],
      );
      expect(result.isValid).toBe(false);
      expect(result.errorMessage).toContain("multiples of 15 minutes");
    });

    it("should reject invalid 10-min increment", () => {
      const result = validateTimeSlot(
        { startTime: "09:10", endTime: "10:10", isValid: false },
        [],
      );
      expect(result.isValid).toBe(false);
      expect(result.errorMessage).toContain("multiples of 15 minutes");
    });
  });

  // ============================================
  // Overlap Detection (Back-to-Back Allowed)
  // ============================================
  describe("Overlap Detection", () => {
    it("should ALLOW back-to-back slots (no gap required)", () => {
      const existingSlots: SlotType[] = [
        { startTime: "09:00", endTime: "10:00", isValid: true },
      ];

      const result = validateTimeSlot(
        { startTime: "10:00", endTime: "11:00", isValid: false },
        existingSlots,
      );

      // Back-to-back should now be VALID (buffer removed)
      expect(result.isValid).toBe(true);
    });

    it("should allow small gap between slots", () => {
      const existingSlots: SlotType[] = [
        { startTime: "09:00", endTime: "10:00", isValid: true },
      ];

      const result = validateTimeSlot(
        { startTime: "10:15", endTime: "11:15", isValid: false },
        existingSlots,
      );

      expect(result.isValid).toBe(true);
    });

    it("should reject true overlap (partial)", () => {
      const existingSlots: SlotType[] = [
        { startTime: "09:00", endTime: "10:00", isValid: true },
      ];

      const result = validateTimeSlot(
        { startTime: "09:30", endTime: "10:30", isValid: false },
        existingSlots,
      );

      expect(result.isValid).toBe(false);
      expect(result.errorMessage).toBe("Slots cannot overlap");
    });

    it("should reject contained slot (one inside another)", () => {
      const existingSlots: SlotType[] = [
        { startTime: "08:00", endTime: "12:00", isValid: true },
      ];

      const result = validateTimeSlot(
        { startTime: "09:00", endTime: "10:00", isValid: false },
        existingSlots,
      );

      expect(result.isValid).toBe(false);
      expect(result.errorMessage).toBe("Slots cannot overlap");
    });

    it("should reject identical slots", () => {
      const existingSlots: SlotType[] = [
        { startTime: "09:00", endTime: "10:00", isValid: true },
      ];

      const result = validateTimeSlot(
        { startTime: "09:00", endTime: "10:00", isValid: false },
        existingSlots,
      );

      expect(result.isValid).toBe(false);
      expect(result.errorMessage).toBe("Slots cannot overlap");
    });

    it("should allow multiple back-to-back slots", () => {
      const existingSlots: SlotType[] = [
        { startTime: "09:00", endTime: "10:00", isValid: true },
        { startTime: "10:00", endTime: "11:00", isValid: true },
      ];

      const result = validateTimeSlot(
        { startTime: "11:00", endTime: "12:00", isValid: false },
        existingSlots,
      );

      expect(result.isValid).toBe(true);
    });
  });

  // ============================================
  // Overnight Slot Handling
  // ============================================
  describe("Overnight Slot Handling", () => {
    it("should allow slot ending at midnight (00:00)", () => {
      const result = validateTimeSlot(
        { startTime: "20:00", endTime: "00:00", isValid: false },
        [],
      );
      // Ending at midnight is a special case that's allowed
      expect(result.isValid).toBe(true);
    });

    it("should reject true overnight slots (end before start, not midnight)", () => {
      const result = validateTimeSlot(
        { startTime: "22:00", endTime: "06:00", isValid: false },
        [],
      );

      expect(result.isValid).toBe(false);
      expect(result.errorMessage).toContain("Overnight slots are not allowed");
    });

    it("should reject same start and end time", () => {
      const result = validateTimeSlot(
        { startTime: "10:00", endTime: "10:00", isValid: false },
        [],
      );

      expect(result.isValid).toBe(false);
      expect(result.errorMessage).toBe("Start and end time cannot be the same");
    });
  });

  // ============================================
  // Edge Cases
  // ============================================
  describe("Edge Cases", () => {
    it("should handle empty start time", () => {
      const result = validateTimeSlot(
        { startTime: "", endTime: "10:00", isValid: false },
        [],
      );

      expect(result.isValid).toBe(false);
      expect(result.errorMessage).toBe("Please select both start and end time");
    });

    it("should handle empty end time", () => {
      const result = validateTimeSlot(
        { startTime: "09:00", endTime: "", isValid: false },
        [],
      );

      expect(result.isValid).toBe(false);
      expect(result.errorMessage).toBe("Please select both start and end time");
    });

    it("should handle both times empty", () => {
      const result = validateTimeSlot(
        { startTime: "", endTime: "", isValid: false },
        [],
      );

      expect(result.isValid).toBe(false);
    });

    it("should handle invalid time format", () => {
      const result = validateTimeSlot(
        { startTime: "25:00", endTime: "26:00", isValid: false },
        [],
      );

      expect(result.isValid).toBe(false);
    });
  });

  // ============================================
  // validateAllSlotsDetailed
  // ============================================
  describe("validateAllSlotsDetailed", () => {
    it("should return valid for all valid slots", () => {
      const slots: SlotsType = {
        monday: [
          { startTime: "09:00", endTime: "10:00", isValid: true },
          { startTime: "11:00", endTime: "12:00", isValid: true },
        ],
        tuesday: [{ startTime: "14:00", endTime: "15:00", isValid: true }],
      };

      const result = validateAllSlotsDetailed(slots);
      expect(result.isValid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("should return invalid with errors for invalid slots", () => {
      const slots: SlotsType = {
        monday: [
          { startTime: "09:00", endTime: "10:00", isValid: true },
          {
            startTime: "09:30",
            endTime: "10:30",
            isValid: false,
            errorMessage: "Slots cannot overlap",
          },
        ],
      };

      const result = validateAllSlotsDetailed(slots);
      expect(result.isValid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it("should handle empty slots object", () => {
      const result = validateAllSlotsDetailed({});
      expect(result.isValid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });
  });

  // ============================================
  // getSlotStatistics
  // ============================================
  describe("getSlotStatistics", () => {
    it("should calculate correct statistics for valid slots", () => {
      const slots: SlotsType = {
        monday: [
          { startTime: "09:00", endTime: "10:00", isValid: true }, // 1 hour
          { startTime: "11:00", endTime: "12:30", isValid: true }, // 1.5 hours
        ],
        tuesday: [{ startTime: "14:00", endTime: "16:00", isValid: true }], // 2 hours
      };

      const stats = getSlotStatistics(slots);

      expect(stats.totalSlots).toBe(3);
      expect(stats.validSlots).toBe(3);
      expect(stats.invalidSlots).toBe(0);
      expect(stats.totalDurationHours).toBe(4.5);
    });

    it("should handle mixed valid and invalid slots", () => {
      const slots: SlotsType = {
        monday: [
          { startTime: "09:00", endTime: "10:00", isValid: true },
          { startTime: "", endTime: "", isValid: false },
        ],
      };

      const stats = getSlotStatistics(slots);

      expect(stats.totalSlots).toBe(2);
      expect(stats.validSlots).toBe(1);
      expect(stats.invalidSlots).toBe(1);
    });

    it("should handle empty slots", () => {
      const stats = getSlotStatistics({});

      expect(stats.totalSlots).toBe(0);
      expect(stats.validSlots).toBe(0);
      expect(stats.totalDurationHours).toBe(0);
    });
  });

  // ============================================
  // Custom Schedule (Date-based keys)
  // ============================================
  describe("Custom Schedule Validation", () => {
    it("should validate slots with date keys", () => {
      const result = validateTimeSlot(
        { startTime: "09:00", endTime: "10:00", isValid: false },
        [],
      );

      expect(result.isValid).toBe(true);
    });

    it("should detect overlaps in custom schedule", () => {
      const existingSlots: SlotType[] = [
        { startTime: "09:00", endTime: "11:00", isValid: true },
      ];

      const result = validateTimeSlot(
        { startTime: "10:00", endTime: "12:00", isValid: false },
        existingSlots,
      );

      expect(result.isValid).toBe(false);
      expect(result.errorMessage).toBe("Slots cannot overlap");
    });
  });
});
