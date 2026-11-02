/**
 * A validate route never reports a too-soon slot as valid, and a too-soon
 * slot never hides a conflict: the validator runs every check past the lead
 * time and the routes bucket `[TOO_SOON]` slots.
 */

import "./setup";

import { categorizeValidationErrors } from "@/lib/booking/validate-conflict-view";
import { ScheduleValidationService } from "@/utils/scheduling-engine/ScheduleValidationService";
import { ScheduleType } from "@prisma/client";

const viewer = { userId: "c-1", isEventConsultant: true };
const SOON = "2030-01-01T10:00:00.000Z";
const LATER = "2030-01-02T10:00:00.000Z";

describe("categorizeValidationErrors", () => {
  it("buckets too-soon slots and leaves only the rest valid", () => {
    const result = categorizeValidationErrors({
      errors: [`[TOO_SOON] 1 time(s) start within 120 min: ${SOON}`],
      slots: [SOON, LATER],
      conflictDetails: new Map(),
      viewer,
      resolveFallbackType: () => "Consultation",
    });
    expect(result.tooSoon).toEqual([{ slot: SOON.slice(0, 19) }]);
    expect(result.validSlots).toEqual([LATER]);
  });

  it("reports nothing valid for a finding no slot bucket can pin", () => {
    const result = categorizeValidationErrors({
      errors: ["[VALIDATION] Consultation slots must be consecutive"],
      slots: [SOON, LATER],
      conflictDetails: new Map(),
      viewer,
      resolveFallbackType: () => "Consultation",
    });
    expect(result.validSlots).toEqual([]);
  });
});

describe("validate() past the lead time", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2030-01-01T09:50:00Z"));
  });
  afterEach(() => jest.useRealTimers());

  it("still reports a conflict on a slot that is also too soon", async () => {
    const findMany = jest.fn().mockResolvedValue([
      {
        id: "other",
        occurrences: [
          {
            startsAt: new Date(SOON),
            endsAt: new Date("2030-01-01T10:30:00.000Z"),
            consultantProfileId: "cp-1",
          },
        ],
        consultation: { status: "APPROVED" },
        subscription: null,
        webinar: null,
        class: null,
        payment: [],
        participants: [{ userId: "u-1" }],
      },
    ]);
    const service = new ScheduleValidationService({
      appointment: { findMany },
    } as never);
    const result = await service.validate(
      "consultation",
      "c-1",
      [new Date(SOON)],
      {
        userId: "u-1",
        scheduleType: ScheduleType.CUSTOM,
        availabilityWindowsWeekly: [],
        availabilityWindowsCustom: [],
      },
      { durationInHours: 0.5 },
      [],
      { overrideAvailabilityWindow: true, consultantProfileId: "cp-1" },
    );
    expect(result.isValid).toBe(false);
    expect(result.errors.some((e) => e.startsWith("[TOO_SOON]"))).toBe(true);
    expect(result.errors.some((e) => e.startsWith("[CONFLICT]"))).toBe(true);
  });
});
