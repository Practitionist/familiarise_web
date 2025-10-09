# Testing Guide

Comprehensive testing documentation for the booking algorithm system.

## Overview

The booking algorithm requires testing at multiple levels:

1. **Unit Tests** - Individual service methods
2. **Integration Tests** - API routes with database
3. **End-to-End Tests** - Full user workflows
4. **Edge Case Tests** - Boundary conditions and error scenarios

**Testing Framework**: Jest + Supertest

---

## Test Structure

### Directory Layout

```
/tests
  /unit
    /slotAllocation
      SlotCalculationService.test.ts
      SlotValidationService.test.ts
      SlotAllocationService.test.ts
    /subscriptionValidation
      SubscriptionValidationService.test.ts
  /integration
    /api
      /consultations
        allocate.test.ts
        validate.test.ts
      /subscriptions
        allocate.test.ts
        validate.test.ts
      /webinars
        allocate.test.ts
        validate.test.ts
      /classes
        allocate.test.ts
        validate.test.ts
  /e2e
    consultation-workflow.test.ts
    subscription-workflow.test.ts
  /fixtures
    testData.ts
    mockDatabase.ts
```

---

## Unit Testing

### Testing SlotCalculationService

**File**: `/tests/unit/slotAllocation/SlotCalculationService.test.ts`

```typescript
import { SlotCalculationService } from "@/utils/slotAllocation/SlotCalculationService";

describe("SlotCalculationService", () => {
  describe("getSlotsPerCall", () => {
    test("should calculate correct slots for standard durations", () => {
      expect(SlotCalculationService.getSlotsPerCall(0.5)).toBe(1);
      expect(SlotCalculationService.getSlotsPerCall(1)).toBe(2);
      expect(SlotCalculationService.getSlotsPerCall(1.5)).toBe(3);
      expect(SlotCalculationService.getSlotsPerCall(2)).toBe(4);
      expect(SlotCalculationService.getSlotsPerCall(2.5)).toBe(5);
    });

    test("should round up fractional slots", () => {
      // 1.25 hours = 2.5 slots → rounds to 3
      expect(SlotCalculationService.getSlotsPerCall(1.25)).toBe(3);
      // 1.75 hours = 3.5 slots → rounds to 4
      expect(SlotCalculationService.getSlotsPerCall(1.75)).toBe(4);
    });

    test("should handle minimum duration (0.5 hours)", () => {
      expect(SlotCalculationService.getSlotsPerCall(0.5)).toBe(1);
    });

    test("should handle large durations", () => {
      expect(SlotCalculationService.getSlotsPerCall(12)).toBe(24);
      expect(SlotCalculationService.getSlotsPerCall(24)).toBe(48);
    });
  });

  describe("countWeeks", () => {
    test("should count weeks correctly across month boundaries", () => {
      const start = new Date("2025-01-06"); // Monday
      const end = new Date("2025-02-02"); // Sunday
      expect(SlotCalculationService.countWeeks(start, end)).toBe(5);
    });

    test("should return 1 for dates in same week", () => {
      const start = new Date("2025-01-06"); // Monday
      const end = new Date("2025-01-10"); // Friday
      expect(SlotCalculationService.countWeeks(start, end)).toBe(1);
    });

    test("should return 0 if end is before start", () => {
      const start = new Date("2025-02-01");
      const end = new Date("2025-01-01");
      expect(SlotCalculationService.countWeeks(start, end)).toBe(0);
    });

    test("should handle same date", () => {
      const date = new Date("2025-01-15");
      expect(SlotCalculationService.countWeeks(date, date)).toBe(1);
    });

    test("should count exact Sunday to Sunday", () => {
      const start = new Date("2025-01-05"); // Sunday
      const end = new Date("2025-01-12"); // Sunday (next week)
      expect(SlotCalculationService.countWeeks(start, end)).toBe(2);
    });
  });

  describe("startOfWeekSunday", () => {
    test("should find Sunday for each day of week", () => {
      const dates = [
        new Date("2025-01-12"), // Sunday
        new Date("2025-01-13"), // Monday
        new Date("2025-01-14"), // Tuesday
        new Date("2025-01-15"), // Wednesday
        new Date("2025-01-16"), // Thursday
        new Date("2025-01-17"), // Friday
        new Date("2025-01-18"), // Saturday
      ];

      dates.forEach((date) => {
        const sunday = SlotCalculationService.startOfWeekSunday(date);
        expect(sunday.getDay()).toBe(0); // 0 = Sunday
        expect(sunday.toDateString()).toBe("Sun Jan 12 2025");
      });
    });

    test("should normalize to midnight", () => {
      const date = new Date("2025-01-15T14:30:00Z"); // Wednesday afternoon
      const sunday = SlotCalculationService.startOfWeekSunday(date);

      expect(sunday.getHours()).toBe(0);
      expect(sunday.getMinutes()).toBe(0);
      expect(sunday.getSeconds()).toBe(0);
      expect(sunday.getMilliseconds()).toBe(0);
    });
  });

  describe("validateDuration", () => {
    test("should accept valid durations", () => {
      expect(() =>
        SlotCalculationService.validateDuration(0.5, "test"),
      ).not.toThrow();
      expect(() =>
        SlotCalculationService.validateDuration(1, "test"),
      ).not.toThrow();
      expect(() =>
        SlotCalculationService.validateDuration(2.5, "test"),
      ).not.toThrow();
      expect(() =>
        SlotCalculationService.validateDuration(24, "test"),
      ).not.toThrow();
    });

    test("should reject undefined duration", () => {
      expect(() =>
        SlotCalculationService.validateDuration(undefined, "test"),
      ).toThrow("test is required but was not provided");
    });

    test("should reject zero duration", () => {
      expect(() => SlotCalculationService.validateDuration(0, "test")).toThrow(
        "test must be positive",
      );
    });

    test("should reject negative duration", () => {
      expect(() => SlotCalculationService.validateDuration(-1, "test")).toThrow(
        "test must be positive",
      );
    });

    test("should reject non-finite duration", () => {
      expect(() =>
        SlotCalculationService.validateDuration(Infinity, "test"),
      ).toThrow("test must be a finite number");
      expect(() =>
        SlotCalculationService.validateDuration(NaN, "test"),
      ).toThrow("test must be a finite number");
    });

    test("should reject duration below minimum (0.5 hours)", () => {
      expect(() =>
        SlotCalculationService.validateDuration(0.25, "test"),
      ).toThrow("test must be at least 0.5 hours");
    });

    test("should reject non-number types", () => {
      expect(() =>
        SlotCalculationService.validateDuration("2" as any, "test"),
      ).toThrow("test must be a number");
    });
  });

  describe("calculateRequiredSlots", () => {
    test("should calculate consultation slots correctly", () => {
      const config = { durationInHours: 2 };
      expect(
        SlotCalculationService.calculateRequiredSlots("consultation", config),
      ).toBe(4); // 2 hours = 4 slots
    });

    test("should calculate webinar slots correctly", () => {
      const config = { durationInHours: 1.5 };
      expect(
        SlotCalculationService.calculateRequiredSlots("webinar", config),
      ).toBe(3); // 1.5 hours = 3 slots
    });

    test("should calculate subscription slots with exact dates", () => {
      const config = {
        startDate: new Date("2025-01-06"),
        endDate: new Date("2025-02-02"),
        callsPerWeek: 2,
        sessionDurationInHours: 1,
      };
      // 5 weeks × 2 calls × 2 slots = 20 slots
      expect(
        SlotCalculationService.calculateRequiredSlots("subscription", config),
      ).toBe(20);
    });

    test("should calculate class slots with exact dates", () => {
      const config = {
        startDate: new Date("2025-02-01"),
        endDate: new Date("2025-03-01"),
        callsPerWeek: 3,
        sessionDurationInHours: 2,
      };
      // 5 weeks × 3 calls × 4 slots = 60 slots
      expect(
        SlotCalculationService.calculateRequiredSlots("class", config),
      ).toBe(60);
    });
  });

  describe("groupSlotsByDay", () => {
    test("should group slots by day correctly", () => {
      const slots = [
        {
          startTime: new Date("2025-01-15T10:00:00Z"),
          endTime: new Date("2025-01-15T10:30:00Z"),
          isAvailable: true,
          isBooked: false,
        },
        {
          startTime: new Date("2025-01-15T10:30:00Z"),
          endTime: new Date("2025-01-15T11:00:00Z"),
          isAvailable: true,
          isBooked: false,
        },
        {
          startTime: new Date("2025-01-17T14:00:00Z"),
          endTime: new Date("2025-01-17T14:30:00Z"),
          isAvailable: true,
          isBooked: false,
        },
      ];

      const grouped = SlotCalculationService.groupSlotsByDay(slots);

      expect(grouped.size).toBe(2);
      expect(grouped.get("Wed Jan 15 2025")?.length).toBe(2);
      expect(grouped.get("Fri Jan 17 2025")?.length).toBe(1);
    });
  });
});
```

### Testing SlotValidationService

**File**: `/tests/unit/slotAllocation/SlotValidationService.test.ts`

```typescript
import { SlotValidationService } from "@/utils/slotAllocation/SlotValidationService";
import { prismaMock } from "../mocks/prisma";

describe("SlotValidationService", () => {
  let validator: SlotValidationService;

  beforeEach(() => {
    validator = new SlotValidationService(prismaMock);
  });

  describe("validateSlotsInFuture", () => {
    test("should accept slots 10 seconds in future", () => {
      const now = new Date();
      const future = new Date(now.getTime() + 10000); // +10 seconds

      const result = validator["validateSlotsInFuture"]([future]);
      expect(result.isValid).toBe(true);
    });

    test("should reject slots 2 seconds in future (within buffer)", () => {
      const now = new Date();
      const tooSoon = new Date(now.getTime() + 2000); // +2 seconds

      const result = validator["validateSlotsInFuture"]([tooSoon]);
      expect(result.isValid).toBe(false);
      expect(result.errors[0]).toContain("only 2.0s");
    });

    test("should reject slots in the past", () => {
      const past = new Date("2020-01-01T10:00:00Z");

      const result = validator["validateSlotsInFuture"]([past]);
      expect(result.isValid).toBe(false);
      expect(result.errors[0]).toContain("ago");
    });
  });

  describe("validateConsecutiveSlots", () => {
    test("should accept perfectly consecutive slots", () => {
      const slots = [
        new Date("2025-01-15T10:00:00Z"),
        new Date("2025-01-15T10:30:00Z"),
        new Date("2025-01-15T11:00:00Z"),
      ];

      const result = validator["validateConsecutiveSlots"](slots);
      expect(result.isValid).toBe(true);
    });

    test("should reject slots with gaps", () => {
      const slots = [
        new Date("2025-01-15T10:00:00Z"),
        new Date("2025-01-15T11:00:00Z"), // Missing 10:30
      ];

      const result = validator["validateConsecutiveSlots"](slots);
      expect(result.isValid).toBe(false);
      expect(result.errors[0]).toContain("Gap detected");
    });

    test("should tolerate sub-second precision errors", () => {
      const slots = [
        new Date("2025-01-15T10:00:00.000Z"),
        new Date("2025-01-15T10:30:00.001Z"), // +1ms difference
      ];

      const result = validator["validateConsecutiveSlots"](slots);
      expect(result.isValid).toBe(true);
    });

    test("should handle out-of-order slots (sorts first)", () => {
      const slots = [
        new Date("2025-01-15T11:00:00Z"),
        new Date("2025-01-15T10:00:00Z"), // Out of order
        new Date("2025-01-15T10:30:00Z"),
      ];

      const result = validator["validateConsecutiveSlots"](slots);
      expect(result.isValid).toBe(true);
    });

    test("should accept single slot", () => {
      const slots = [new Date("2025-01-15T10:00:00Z")];

      const result = validator["validateConsecutiveSlots"](slots);
      expect(result.isValid).toBe(true);
    });
  });

  describe("validateSameDaySlots", () => {
    test("should accept slots on same day", () => {
      const slots = [
        new Date("2025-01-15T10:00:00Z"),
        new Date("2025-01-15T14:00:00Z"),
        new Date("2025-01-15T16:00:00Z"),
      ];

      const result = validator["validateSameDaySlots"](slots);
      expect(result.isValid).toBe(true);
    });

    test("should reject slots on different days", () => {
      const slots = [
        new Date("2025-01-15T10:00:00Z"),
        new Date("2025-01-16T10:00:00Z"), // Next day
      ];

      const result = validator["validateSameDaySlots"](slots);
      expect(result.isValid).toBe(false);
      expect(result.errors[0]).toContain("must be on the same day");
    });
  });

  describe("validateSchedulingPeriod", () => {
    test("should accept slots within period", () => {
      const slots = [
        new Date("2025-01-15T10:00:00Z"),
        new Date("2025-02-15T10:00:00Z"),
      ];
      const start = new Date("2025-01-01");
      const end = new Date("2025-03-01");

      const result = validator["validateSchedulingPeriod"](slots, start, end);
      expect(result.isValid).toBe(true);
    });

    test("should reject slots before period", () => {
      const slots = [new Date("2024-12-15T10:00:00Z")];
      const start = new Date("2025-01-01");
      const end = new Date("2025-03-01");

      const result = validator["validateSchedulingPeriod"](slots, start, end);
      expect(result.isValid).toBe(false);
      expect(result.errors[0]).toContain("outside the scheduling period");
    });

    test("should reject slots after period", () => {
      const slots = [new Date("2025-04-15T10:00:00Z")];
      const start = new Date("2025-01-01");
      const end = new Date("2025-03-01");

      const result = validator["validateSchedulingPeriod"](slots, start, end);
      expect(result.isValid).toBe(false);
      expect(result.errors[0]).toContain("outside the scheduling period");
    });
  });
});
```

---

## Integration Testing

### Testing API Routes

**File**: `/tests/integration/api/consultations/allocate.test.ts`

```typescript
import { createMocks } from "node-mocks-http";
import { PATCH } from "@/app/api/events/consultations/[consultationId]/allocate/route";
import { prismaMock } from "../../mocks/prisma";

describe("POST /api/events/consultations/[id]/allocate", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("should allocate slots successfully (manual)", async () => {
    // Mock consultation data
    prismaMock.consultation.findUnique.mockResolvedValue({
      id: "consultation-123",
      consultationPlanId: "plan-123",
      requestStatus: "PENDING",
      consultationPlan: {
        durationInHours: 2,
        consultantProfile: {
          user: { id: "consultant-1", currentTimezone: "UTC" },
          scheduleType: "WEEKLY",
          slotsOfAvailabilityWeekly: [
            { slotStartTimeInUTC: new Date("2025-01-13T10:00:00Z") },
            { slotStartTimeInUTC: new Date("2025-01-13T10:30:00Z") },
            { slotStartTimeInUTC: new Date("2025-01-13T11:00:00Z") },
            { slotStartTimeInUTC: new Date("2025-01-13T11:30:00Z") },
          ],
          slotsOfAvailabilityCustom: [],
        },
      },
      requestedBy: {
        user: { id: "consultee-1", name: "John Doe" },
      },
    } as any);

    // Mock no existing appointments (no conflicts)
    prismaMock.appointment.findFirst.mockResolvedValue(null);

    // Mock appointment creation
    prismaMock.appointment.create.mockResolvedValue({
      id: "appointment-123",
      appointmentType: "CONSULTATION",
      consultationId: "consultation-123",
      slotsOfAppointment: [
        {
          id: "slot-1",
          slotStartTimeInUTC: new Date("2025-01-15T10:00:00Z"),
          slotEndTimeInUTC: new Date("2025-01-15T10:30:00Z"),
          isTentative: false,
        },
        {
          id: "slot-2",
          slotStartTimeInUTC: new Date("2025-01-15T10:30:00Z"),
          slotEndTimeInUTC: new Date("2025-01-15T11:00:00Z"),
          isTentative: false,
        },
        {
          id: "slot-3",
          slotStartTimeInUTC: new Date("2025-01-15T11:00:00Z"),
          slotEndTimeInUTC: new Date("2025-01-15T11:30:00Z"),
          isTentative: false,
        },
        {
          id: "slot-4",
          slotStartTimeInUTC: new Date("2025-01-15T11:30:00Z"),
          slotEndTimeInUTC: new Date("2025-01-15T12:00:00Z"),
          isTentative: false,
        },
      ],
    } as any);

    const { req, res } = createMocks({
      method: "PATCH",
      body: {
        isAuto: false,
        slots: [
          "2025-01-15T10:00:00Z",
          "2025-01-15T10:30:00Z",
          "2025-01-15T11:00:00Z",
          "2025-01-15T11:30:00Z",
        ],
      },
    });

    const params = Promise.resolve({ consultationId: "consultation-123" });
    await PATCH(req as any, { params } as any);

    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res._getData());
    expect(data.data).toHaveLength(1);
    expect(data.data[0].slotsOfAppointment).toHaveLength(4);
  });

  test("should reject invalid slot count", async () => {
    prismaMock.consultation.findUnique.mockResolvedValue({
      id: "consultation-123",
      consultationPlan: {
        durationInHours: 2, // Requires 4 slots
        consultantProfile: {
          user: { id: "consultant-1", currentTimezone: "UTC" },
          scheduleType: "WEEKLY",
          slotsOfAvailabilityWeekly: [],
          slotsOfAvailabilityCustom: [],
        },
      },
      requestedBy: { user: { id: "consultee-1" } },
    } as any);

    const { req, res } = createMocks({
      method: "PATCH",
      body: {
        isAuto: false,
        slots: [
          "2025-01-15T10:00:00Z",
          "2025-01-15T10:30:00Z",
          "2025-01-15T11:00:00Z",
          // Only 3 slots, but need 4
        ],
      },
    });

    const params = Promise.resolve({ consultationId: "consultation-123" });
    await PATCH(req as any, { params } as any);

    expect(res.statusCode).toBe(500);
    const data = JSON.parse(res._getData());
    expect(data.error).toContain("Invalid slot count");
  });

  test("should reject conflicting slots", async () => {
    prismaMock.consultation.findUnique.mockResolvedValue({
      id: "consultation-123",
      consultationPlan: {
        durationInHours: 1,
        consultantProfile: {
          user: { id: "consultant-1", currentTimezone: "UTC" },
          scheduleType: "WEEKLY",
          slotsOfAvailabilityWeekly: [
            { slotStartTimeInUTC: new Date("2025-01-13T10:00:00Z") },
            { slotStartTimeInUTC: new Date("2025-01-13T10:30:00Z") },
          ],
          slotsOfAvailabilityCustom: [],
        },
      },
      requestedBy: { user: { id: "consultee-1" } },
    } as any);

    // Mock existing appointment (conflict)
    prismaMock.appointment.findFirst.mockResolvedValue({
      id: "existing-appointment",
      consultation: {
        requestedBy: { user: { name: "Jane Doe" } },
      },
    } as any);

    const { req, res } = createMocks({
      method: "PATCH",
      body: {
        isAuto: false,
        slots: ["2025-01-15T10:00:00Z", "2025-01-15T10:30:00Z"],
      },
    });

    const params = Promise.resolve({ consultationId: "consultation-123" });
    await PATCH(req as any, { params } as any);

    expect(res.statusCode).toBe(500);
    const data = JSON.parse(res._getData());
    expect(data.error).toContain("Slot already booked");
  });
});
```

---

## End-to-End Testing

### Complete User Workflow

**File**: `/tests/e2e/consultation-workflow.test.ts`

```typescript
import { test, expect } from "@playwright/test";

test.describe("Consultation Booking Workflow", () => {
  test("should complete full consultation booking", async ({ page }) => {
    // Step 1: Login as consultee
    await page.goto("/login");
    await page.fill('[name="email"]', "consultee@test.com");
    await page.fill('[name="password"]', "password123");
    await page.click('button[type="submit"]');

    // Step 2: Browse consultants
    await page.goto("/consultants");
    await page.click('[data-testid="consultant-card-1"]');

    // Step 3: Select consultation plan
    await page.click('[data-testid="consultation-plan-2hr"]');

    // Step 4: Select time slots
    await page.click('[data-testid="calendar-date-2025-02-15"]');
    await page.click('[data-testid="slot-10:00"]');
    await page.click('[data-testid="slot-10:30"]');
    await page.click('[data-testid="slot-11:00"]');
    await page.click('[data-testid="slot-11:30"]');

    // Step 5: Validate slots
    await page.click('[data-testid="validate-slots-button"]');
    await expect(
      page.locator('[data-testid="validation-success"]'),
    ).toBeVisible();

    // Step 6: Submit request
    await page.click('[data-testid="submit-request-button"]');
    await expect(page.locator('[data-testid="request-success"]')).toBeVisible();

    // Step 7: Verify request created
    await page.goto("/consultee/requests");
    await expect(page.locator('[data-testid="request-status"]')).toHaveText(
      "PENDING",
    );
  });

  test("should handle slot conflicts gracefully", async ({ page }) => {
    // ... similar setup ...

    // Select conflicting slot
    await page.click('[data-testid="slot-10:00"]'); // Already booked

    // Should show conflict warning
    await expect(
      page.locator('[data-testid="conflict-warning"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="conflict-warning"]'),
    ).toContainText("already booked");

    // Submit button should be disabled
    await expect(
      page.locator('[data-testid="submit-request-button"]'),
    ).toBeDisabled();
  });
});
```

---

## Edge Case Testing

### Critical Edge Cases

```typescript
describe("Edge Cases", () => {
  describe("Duplicate Slots", () => {
    test("should reject duplicate slots in selection", async () => {
      const slots = [
        "2025-01-15T10:00:00Z",
        "2025-01-15T10:00:00Z", // Duplicate
        "2025-01-15T10:30:00Z",
      ];

      await expect(allocateSlots({ isAuto: false, slots })).rejects.toThrow(
        "Duplicate slots detected",
      );
    });
  });

  describe("Past Slots", () => {
    test("should reject slots in the past", async () => {
      const pastSlot = new Date("2020-01-01T10:00:00Z");

      await expect(validateSlots([pastSlot])).rejects.toThrow(
        "Cannot allocate slots in the past",
      );
    });

    test("should handle race condition with 5-second buffer", async () => {
      const now = new Date();
      const tooSoon = new Date(now.getTime() + 2000); // 2 seconds

      await expect(validateSlots([tooSoon])).rejects.toThrow("too soon");
    });
  });

  describe("Week Boundaries", () => {
    test("should correctly count weeks across month end", () => {
      const start = new Date("2025-01-29"); // Wed
      const end = new Date("2025-02-04"); // Tue

      // Week 1: Sun Jan 26 - Sat Feb 1
      // Week 2: Sun Feb 2 - Sat Feb 8
      expect(countWeeks(start, end)).toBe(2);
    });

    test("should handle leap year February", () => {
      const start = new Date("2024-02-01");
      const end = new Date("2024-02-29"); // Leap year

      // 5 weeks in Feb 2024
      expect(countWeeks(start, end)).toBe(5);
    });
  });

  describe("Daylight Saving Time", () => {
    test("should handle DST transition (spring forward)", () => {
      // March 9, 2025: DST begins (2 AM → 3 AM)
      const beforeDST = new Date("2025-03-09T01:00:00Z");
      const afterDST = new Date("2025-03-09T03:00:00Z");

      const slots = [beforeDST, afterDST];
      // Should still work with UTC storage
      expect(() => validateSlots(slots)).not.toThrow();
    });
  });

  describe("Floating-Point Precision", () => {
    test("should tolerate millisecond precision errors", () => {
      const slots = [
        new Date("2025-01-15T10:00:00.000Z"),
        new Date("2025-01-15T10:30:00.001Z"), // 1ms off
      ];

      const result = validateConsecutiveSlots(slots);
      expect(result.isValid).toBe(true);
    });
  });

  describe("Malformed Data", () => {
    test("should handle invalid event ID", async () => {
      await expect(allocateSlots({ eventId: "not-a-uuid" })).rejects.toThrow(
        "Event ID must be a valid UUID format",
      );
    });

    test("should handle negative duration", () => {
      expect(() => validateDuration(-1, "test")).toThrow("must be positive");
    });

    test("should handle Infinity duration", () => {
      expect(() => validateDuration(Infinity, "test")).toThrow(
        "must be a finite number",
      );
    });

    test("should handle startDate after endDate", async () => {
      const config = {
        startDate: new Date("2025-03-01"),
        endDate: new Date("2025-01-01"), // End before start!
      };

      await expect(fetchEventData("subscription", config)).rejects.toThrow(
        "Invalid date range",
      );
    });
  });

  describe("Maximum Limits", () => {
    test("should prevent infinite loop with iteration limit", () => {
      const malformed = {
        startDate: new Date("3000-01-01"),
        endDate: new Date("2020-01-01"),
      };

      expect(() => generateWeeklyInfo(malformed)).toThrow(
        "exceeds maximum duration",
      );
    });

    test("should warn on unusually large duration", () => {
      const spy = jest.spyOn(console, "warn");
      validateDuration(30, "test"); // 30 hours

      expect(spy).toHaveBeenCalledWith(
        expect.stringContaining("unusually large"),
      );
    });
  });
});
```

---

## Test Data Fixtures

**File**: `/tests/fixtures/testData.ts`

```typescript
export const mockConsultant = {
  id: "consultant-1",
  user: {
    id: "user-1",
    name: "Dr. Jane Smith",
    currentTimezone: "UTC",
  },
  scheduleType: "WEEKLY",
  slotsOfAvailabilityWeekly: [
    // Monday 10:00-12:00
    { slotStartTimeInUTC: new Date("2025-01-13T10:00:00Z") },
    { slotStartTimeInUTC: new Date("2025-01-13T10:30:00Z") },
    { slotStartTimeInUTC: new Date("2025-01-13T11:00:00Z") },
    { slotStartTimeInUTC: new Date("2025-01-13T11:30:00Z") },
    // Wednesday 14:00-16:00
    { slotStartTimeInUTC: new Date("2025-01-15T14:00:00Z") },
    { slotStartTimeInUTC: new Date("2025-01-15T14:30:00Z") },
    { slotStartTimeInUTC: new Date("2025-01-15T15:00:00Z") },
    { slotStartTimeInUTC: new Date("2025-01-15T15:30:00Z") },
  ],
  slotsOfAvailabilityCustom: [],
};

export const mockConsultationPlan = {
  id: "plan-1",
  durationInHours: 2,
  consultantProfile: mockConsultant,
};

export const mockSubscriptionPlan = {
  id: "plan-2",
  durationInMonths: 2,
  callsPerWeek: 2,
  sessionDurationInHours: 1.5,
  consultantProfile: mockConsultant,
};

export const mockConsultation = {
  id: "consultation-1",
  consultationPlanId: "plan-1",
  requestStatus: "PENDING",
  consultationPlan: mockConsultationPlan,
  requestedBy: {
    user: {
      id: "consultee-1",
      name: "John Doe",
    },
  },
};

export const futureSlots = {
  twoHours: [
    new Date("2025-02-15T10:00:00Z"),
    new Date("2025-02-15T10:30:00Z"),
    new Date("2025-02-15T11:00:00Z"),
    new Date("2025-02-15T11:30:00Z"),
  ],
  oneHour: [new Date("2025-02-15T10:00:00Z"), new Date("2025-02-15T10:30:00Z")],
};
```

---

## Running Tests

### Commands

```bash
# Run all tests
npm test

# Run specific test file
npm test SlotCalculationService.test.ts

# Run with coverage
npm test -- --coverage

# Watch mode
npm test -- --watch

# Run integration tests only
npm test -- --testPathPattern=integration

# Run e2e tests
npm run test:e2e
```

### Jest Configuration

**File**: `jest.config.js`

```javascript
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/tests"],
  testMatch: ["**/*.test.ts"],
  collectCoverageFrom: [
    "utils/**/*.ts",
    "app/api/**/*.ts",
    "!**/*.d.ts",
    "!**/node_modules/**",
  ],
  coverageThreshold: {
    global: {
      branches: 80,
      functions: 80,
      lines: 80,
      statements: 80,
    },
  },
  setupFilesAfterEnv: ["<rootDir>/tests/setup.ts"],
};
```

---

## Test Coverage Goals

| Component                     | Target Coverage | Current |
| ----------------------------- | --------------- | ------- |
| SlotCalculationService        | 95%             | ✓       |
| SlotValidationService         | 90%             | ✓       |
| SlotAllocationService         | 85%             | ✓       |
| SubscriptionValidationService | 90%             | ✓       |
| API Routes                    | 80%             | ✓       |

---

## Continuous Integration

### GitHub Actions Workflow

**File**: `.github/workflows/test.yml`

```yaml
name: Tests

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v3

      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: "18"

      - name: Install dependencies
        run: npm ci

      - name: Run linter
        run: npm run lint

      - name: Run unit tests
        run: npm test -- --testPathPattern=unit

      - name: Run integration tests
        run: npm test -- --testPathPattern=integration

      - name: Run e2e tests
        run: npm run test:e2e

      - name: Upload coverage
        uses: codecov/codecov-action@v3
        with:
          file: ./coverage/coverage-final.json
```

---

## Best Practices

1. **Test Isolation**: Each test should be independent
2. **Mock External Dependencies**: Database, APIs, etc.
3. **Test Edge Cases**: Don't just test the happy path
4. **Descriptive Test Names**: `should reject duplicate slots in selection`
5. **Arrange-Act-Assert**: Clear test structure
6. **Use Test Fixtures**: Reusable test data
7. **Test Error Messages**: Verify user-friendly errors
8. **Coverage Goals**: Aim for 80%+ coverage
9. **Fast Tests**: Unit tests < 1s, integration < 5s
10. **CI/CD Integration**: Run tests on every commit

---

## Next Steps

- **Event Types**: See `03_EVENT_TYPES.md` for event-specific testing scenarios
- **Validation**: See `04_VALIDATION_LAYERS.md` for validation layer testing
- **Troubleshooting**: See `08_TROUBLESHOOTING.md` for debugging failed tests
- **Bug Fixes**: See `07_BUG_FIXES_CHANGELOG.md` for regression test cases
