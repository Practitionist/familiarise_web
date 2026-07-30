/**
 * Mode parity: the three allocation entry points (manual / auto / requested)
 * must agree on required-slot math — including the in-progress reschedule
 * reduction — and auto-allocate's output must pass the manual validators
 * under the shared UTC bucketing.
 */

process.env.TZ = "Asia/Kolkata";

import "./setup";

import {
  AllocationAlgorithms,
  type AllocationOptions,
} from "@/lib/scheduling/allocationAlgorithms";
import { AllocationService } from "@/lib/scheduling/allocationService";
import {
  validateEventSlots,
  getEventConstraints,
  getSlotLimits,
  groupSlotsByDay,
} from "@/lib/scheduling/slotSelectionValidation";
import {
  validateSlotDistribution,
  type TimeSlot,
} from "@/lib/scheduling/calendarUtils";
// eslint-disable-next-line jest/no-mocks-import -- shared fixture builders, not module mocks (suite-wide pattern)
import { makeConsecutiveTimeSlots } from "./__mocks__/booking.mockData";

let mockAllocateSlots: jest.SpyInstance;

beforeEach(() => {
  mockAllocateSlots = jest
    .spyOn(AllocationService, "allocateSlots")
    .mockResolvedValue({ success: true, data: [] });
});

afterEach(() => {
  jest.restoreAllMocks();
});

/** Availability grid: `hoursPerDay` hours of 30-min slots per day for every
 * day in [start, days). Times chosen to include the IST/UTC boundary. */
function makeAvailabilityGrid(
  startISO: string,
  days: number,
  hoursPerDay = 4,
): TimeSlot[] {
  const slots: TimeSlot[] = [];
  const dayStart = new Date(startISO);
  for (let d = 0; d < days; d++) {
    const base = new Date(dayStart.getTime() + d * 24 * 60 * 60 * 1000);
    slots.push(
      ...(makeConsecutiveTimeSlots(
        base.toISOString(),
        hoursPerDay * 2,
      ) as TimeSlot[]),
    );
  }
  return slots;
}

const FUTURE_SUNDAY = "2026-08-02T09:00:00.000Z"; // Sunday, comfortably future

describe("auto-allocate output passes manual validation (UTC bucketing)", () => {
  it.each([
    { sessionsPerWeek: 1, sessionDurationInHours: 1 },
    { sessionsPerWeek: 2, sessionDurationInHours: 1.5 },
    { sessionsPerWeek: 3, sessionDurationInHours: 0.5 },
  ])(
    "subscription %o: picked slots satisfy every manual validator",
    async ({ sessionsPerWeek, sessionDurationInHours }) => {
      const startDate = new Date("2026-08-02T00:00:00.000Z"); // Sunday
      const endDate = new Date("2026-08-29T23:59:59.000Z"); // Saturday (4 weeks)
      const totalSessions = 4 * sessionsPerWeek;
      const slotsPerCall = Math.ceil(sessionDurationInHours / 0.5);

      const options: AllocationOptions = {
        eventType: "subscription",
        eventId: "sub-1",
        sessionsPerWeek,
        sessionDurationInHours,
        startDate,
        endDate,
        totalSessions,
        maxCallsPerDay: 1,
      };

      const result = await AllocationAlgorithms.autoAllocate(
        makeAvailabilityGrid(FUTURE_SUNDAY, 28, 6),
        options,
      );

      expect(result.success).toBe(true);
      const picked = result.selectedSlots;
      expect(picked).toHaveLength(totalSessions * slotsPerCall);

      // The same selection must pass the interactive validators…
      const validationOptions = {
        sessionsPerWeek,
        sessionDurationInHours,
        maxTotalCalls: totalSessions,
        startDate,
        endDate,
      };
      const constraints = getEventConstraints("subscription", validationOptions);
      const limits = getSlotLimits("subscription", validationOptions);
      const verdict = validateEventSlots(
        picked,
        "subscription",
        constraints,
        limits,
        validationOptions,
      );
      expect(verdict.errors).toEqual([]);
      expect(verdict.isValid).toBe(true);

      // …and the manual-allocate weekly distribution check…
      const distribution = validateSlotDistribution(
        picked,
        sessionsPerWeek * slotsPerCall,
      );
      expect(distribution.isValid).toBe(true);

      // …and the per-day cap under UTC day keys.
      groupSlotsByDay(picked).forEach((daySlots) => {
        expect(daySlots.length).toBeLessThanOrEqual(slotsPerCall);
      });
    },
  );

  it("explicit non-default timezone is honored end-to-end (America/New_York)", async () => {
    const schedulingTimezone = "America/New_York";
    const startDate = new Date("2026-08-02T00:00:00.000Z");
    const endDate = new Date("2026-08-29T23:59:59.000Z");
    const options: AllocationOptions = {
      eventType: "subscription",
      eventId: "sub-tz",
      sessionsPerWeek: 1,
      sessionDurationInHours: 1,
      startDate,
      endDate,
      totalSessions: 4,
      maxCallsPerDay: 1,
      schedulingTimezone,
    };

    const result = await AllocationAlgorithms.autoAllocate(
      makeAvailabilityGrid(FUTURE_SUNDAY, 28, 6),
      options,
    );
    expect(result.success).toBe(true);

    const validationOptions = {
      sessionsPerWeek: 1,
      sessionDurationInHours: 1,
      maxTotalCalls: 4,
      startDate,
      endDate,
      schedulingTimezone,
    };
    const verdict = validateEventSlots(
      result.selectedSlots,
      "subscription",
      getEventConstraints("subscription", validationOptions),
      getSlotLimits("subscription", validationOptions),
      validationOptions,
    );
    expect(verdict.errors).toEqual([]);

    // Per-day cap holds under the SAME (non-default) timezone the allocator used
    groupSlotsByDay(result.selectedSlots, schedulingTimezone).forEach(
      (daySlots) => {
        expect(daySlots.length).toBeLessThanOrEqual(2);
      },
    );
    expect(
      validateSlotDistribution(result.selectedSlots, 2, schedulingTimezone)
        .isValid,
    ).toBe(true);
  });

  it("class: per-day cap of 2 sessions holds in the auto output", async () => {
    const startDate = new Date("2026-08-02T00:00:00.000Z");
    const endDate = new Date("2026-08-29T23:59:59.000Z");
    const options: AllocationOptions = {
      eventType: "class",
      eventId: "class-1",
      sessionsPerWeek: 2,
      sessionDurationInHours: 1,
      startDate,
      endDate,
      totalSessions: 8,
      maxSessionsPerDay: 2,
    };

    const result = await AllocationAlgorithms.autoAllocate(
      makeAvailabilityGrid(FUTURE_SUNDAY, 28, 8),
      options,
    );
    expect(result.success).toBe(true);

    groupSlotsByDay(result.selectedSlots).forEach((daySlots) => {
      // ≤ 2 sessions of 2 atoms per UTC day
      expect(daySlots.length).toBeLessThanOrEqual(2 * 2);
    });
  });
});

describe("required-count parity across the three modes", () => {
  const base: AllocationOptions = {
    eventType: "subscription",
    eventId: "sub-1",
    sessionsPerWeek: 1,
    sessionDurationInHours: 1,
    startDate: new Date("2026-08-02T00:00:00.000Z"),
    endDate: new Date("2026-08-29T23:59:59.000Z"),
    totalSessions: 4, // 4 sessions × 2 atoms = 8 slots
  };

  it("manual and requested reject the same wrong count with the same expectation", async () => {
    const sixSlots = [
      ...makeConsecutiveTimeSlots("2026-08-03T09:00:00.000Z", 2),
      ...makeConsecutiveTimeSlots("2026-08-10T09:00:00.000Z", 2),
      ...makeConsecutiveTimeSlots("2026-08-17T09:00:00.000Z", 2),
    ] as TimeSlot[];

    const manual = await AllocationAlgorithms.manualAllocate(sixSlots, base);
    expect(manual.success).toBe(false);
    expect(manual.error).toContain("Expected 8 slots but received 6");

    const requested = await AllocationAlgorithms.allocateRequestedSlots({
      ...base,
      requestedSlots: sixSlots,
    });
    expect(requested.success).toBe(false);
    expect(requested.error).toContain("Requested 6 slots but need 8");
  });

  it("requested honors pastConfirmedSlotCount like manual (in-progress reschedule)", async () => {
    // 1 of 4 sessions already confirmed in the past → only 6 future atoms due.
    const withPast = { ...base, pastConfirmedSlotCount: 2 };
    const sixSlots = [
      ...makeConsecutiveTimeSlots("2026-08-03T09:00:00.000Z", 2),
      ...makeConsecutiveTimeSlots("2026-08-10T09:00:00.000Z", 2),
      ...makeConsecutiveTimeSlots("2026-08-17T09:00:00.000Z", 2),
    ] as TimeSlot[];

    const manual = await AllocationAlgorithms.manualAllocate(
      sixSlots,
      withPast,
    );
    expect(manual.success).toBe(true);

    const requested = await AllocationAlgorithms.allocateRequestedSlots({
      ...withPast,
      requestedSlots: sixSlots,
    });
    expect(requested.success).toBe(true);
    expect(mockAllocateSlots).toHaveBeenCalledTimes(2);
  });

  it("requested honors totalSessions as authoritative (previously ignored)", async () => {
    // Period spans 4 weeks × 1 call = 4 sessions, but the plan says 2.
    const twoSessionPlan = { ...base, totalSessions: 2 };
    const fourSlots = [
      ...makeConsecutiveTimeSlots("2026-08-03T09:00:00.000Z", 2),
      ...makeConsecutiveTimeSlots("2026-08-10T09:00:00.000Z", 2),
    ] as TimeSlot[];

    const requested = await AllocationAlgorithms.allocateRequestedSlots({
      ...twoSessionPlan,
      requestedSlots: fourSlots,
    });
    expect(requested.success).toBe(true);
  });
});

describe("getSlotLimits defensive bounds", () => {
  it("maxSlots floors at 0 when past sessions exceed the plan total (over-allocated data)", () => {
    const limits = getSlotLimits("subscription", {
      sessionDurationInHours: 1,
      maxTotalCalls: 4,
      // 6 past sessions × 2 atoms — more than the plan's 4 sessions
      pastConfirmedSlotCount: 12,
      sessionsPerWeek: 1,
      startDate: new Date("2026-08-02T00:00:00.000Z"),
      endDate: new Date("2026-08-29T23:59:59.000Z"),
    });
    expect(limits.maxSlots).toBe(0);
  });
});

describe("consecutive-atom rules at the scheduling-timezone day boundary", () => {
  it("a consultation straddling IST midnight is rejected (same-day rule, server parity)", () => {
    // 18:00Z–19:00Z = 23:30–00:30 IST: consecutive but on two IST days.
    const straddling = makeConsecutiveTimeSlots(
      "2026-08-03T18:00:00.000Z",
      2,
    ) as TimeSlot[];
    const options = { durationInHours: 1 };
    const verdict = validateEventSlots(
      straddling,
      "consultation",
      getEventConstraints("consultation", options),
      getSlotLimits("consultation", options),
      options,
    );
    expect(verdict.isValid).toBe(false);
    expect(verdict.errors.join(" ")).toContain("same day");
  });

  it("1.5h and 2h sessions require 3 and 4 consecutive same-day atoms", () => {
    for (const [duration, atoms] of [
      [1.5, 3],
      [2, 4],
    ] as const) {
      const options = { durationInHours: duration };
      const consecutive = makeConsecutiveTimeSlots(
        "2026-08-03T09:00:00.000Z",
        atoms,
      ) as TimeSlot[];
      const gappy = [
        ...makeConsecutiveTimeSlots("2026-08-03T09:00:00.000Z", atoms - 1),
        ...makeConsecutiveTimeSlots("2026-08-03T14:00:00.000Z", 1),
      ] as TimeSlot[];

      const good = validateEventSlots(
        consecutive,
        "consultation",
        getEventConstraints("consultation", options),
        getSlotLimits("consultation", options),
        options,
      );
      expect(good.isValid).toBe(true);

      const bad = validateEventSlots(
        gappy,
        "consultation",
        getEventConstraints("consultation", options),
        getSlotLimits("consultation", options),
        options,
      );
      expect(bad.isValid).toBe(false);
    }
  });
});
