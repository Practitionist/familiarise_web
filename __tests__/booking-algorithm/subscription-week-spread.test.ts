/**
 * Auto placement spreads a subscription's sessions across its plan week: with
 * every day open, 3 a week lands on alternate days (Mon/Wed/Fri), not on the
 * first three days in a row. When the week cannot keep a free day between
 * sessions, packing still places every session.
 */

import "./setup";
import { emptySearchDb } from "../fixtures/allocator-search";

import type { DayOfWeek } from "@prisma/client";
import {
  adjacentDayKeys,
  findAvailableSlots,
} from "../../lib/booking/allocation/search/find-available-slots";
import { ScheduleCalculationService } from "../../utils/scheduling-engine/ScheduleCalculationService";
import type {
  ConsultantAllocationData,
  EventConfig,
  EventType,
} from "../../utils/scheduling-engine/types";
import { weeklyRowLocalColumns } from "@/utils/schedule/weekly-projection";
import type { AllocationPreference } from "@/utils/scheduling-engine/preferenceScoring";

const IST = "Asia/Kolkata";
const IST_OFFSET = 330;
const DAYS: DayOfWeek[] = [
  "MONDAY",
  "TUESDAY",
  "WEDNESDAY",
  "THURSDAY",
  "FRIDAY",
  "SATURDAY",
  "SUNDAY",
];

/** IST 10:00–12:00 on each of `days`. */
function consultantOn(days: DayOfWeek[]): ConsultantAllocationData {
  return {
    userId: "consultant-user",
    scheduleType: "WEEKLY",
    availabilityWindowsWeekly: days.map((day, i) => ({
      id: `weekly-${i}`,
      ...weeklyRowLocalColumns(
        {
          startDay: day,
          startTimeUtc: 600 - IST_OFFSET,
          endTimeUtc: 720 - IST_OFFSET,
        },
        IST,
        IST_OFFSET,
      ),
    })),
    availabilityWindowsCustom: [],
  };
}

// Mon 10 Aug 2026 00:00 IST to Mon 17 Aug: one plan week.
const weekConfig: EventConfig = {
  sessionsPerWeek: 3,
  sessionDurationInHours: 1,
  schedulingPeriodStartsAt: new Date("2026-08-09T18:30:00.000Z"),
  schedulingPeriodEndsAt: new Date("2026-08-16T18:30:00.000Z"),
  schedulingTimezone: IST,
};

const place = (
  consultant: ConsultantAllocationData,
  eventType: EventType,
  preference?: AllocationPreference,
) =>
  findAvailableSlots(
    emptySearchDb(),
    consultant,
    6,
    2,
    eventType,
    weekConfig,
    [],
    [],
    undefined,
    undefined,
    preference,
  );

const weekdaysOf = (slots: Date[]) => [
  ...new Set(slots.map((s) => ScheduleCalculationService.weekdayInTz(s, IST))),
];

beforeAll(() => {
  jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] });
  jest.setSystemTime(new Date("2026-08-08T12:00:00Z"));
});
afterAll(() => jest.useRealTimers());

it("places 3 a week on alternate days when every day is open", async () => {
  const slots = await place(consultantOn(DAYS), "subscription");
  expect(slots).toHaveLength(6);
  // 1 = Monday … 5 = Friday (Sunday = 0).
  expect(weekdaysOf(slots)).toEqual([1, 3, 5]);
});

it("still places every session when only consecutive days are open", async () => {
  const slots = await place(
    consultantOn(["MONDAY", "TUESDAY", "WEDNESDAY"]),
    "subscription",
  );
  expect(slots).toHaveLength(6);
  expect(weekdaysOf(slots)).toEqual([1, 2, 3]);
});

it("keeps the free day between sessions when a preference is set too", async () => {
  const slots = await place(consultantOn(DAYS), "subscription", {
    preferredDays: "WEEKDAYS",
  });
  expect(slots).toHaveLength(6);
  expect(weekdaysOf(slots)).toEqual([1, 3, 5]);
});

it("finds the neighbouring local days across a daylight-saving change", () => {
  // Sat 7 Mar 2026 23:30 in New York; clocks spring forward that night, so
  // 24 hours later is already Monday 00:30.
  const saturdayLate = new Date("2026-03-08T04:30:00.000Z");
  expect(adjacentDayKeys(saturdayLate, "America/New_York")).toEqual([
    "2026-03-06",
    "2026-03-08",
  ]);
});
