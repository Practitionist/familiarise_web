/**
 * Shared mock data for booking algorithm tests.
 *
 * Provides factories and fixtures for:
 * - Time slots (30-min, 1-hour, multi-hour)
 * - Subscription plans & subscriptions
 * - Appointments with slot records
 * - Consultant availability (weekly & custom)
 */

import { ScheduleType, DayOfWeek } from "@prisma/client";

// ─── Time Helpers ───────────────────────────────────────────────────────────

/** Create a Date for a given ISO string or relative day offset from a base date */
export function makeDate(iso: string): Date {
  return new Date(iso);
}

/** Create a Date at a specific hour:minute on a given date string (UTC) */
export function makeUTCDate(
  dateStr: string,
  hour: number,
  minute: number = 0,
): Date {
  const d = new Date(dateStr);
  d.setUTCHours(hour, minute, 0, 0);
  return d;
}

/** Generate N consecutive 30-minute slot ISO strings starting at a given time */
export function makeConsecutiveSlotISOs(
  startISO: string,
  count: number,
): string[] {
  const slots: string[] = [];
  let current = new Date(startISO);
  for (let i = 0; i < count; i++) {
    slots.push(current.toISOString());
    current = new Date(current.getTime() + 30 * 60 * 1000);
  }
  return slots;
}

// ─── CalendarInterval Factory (calendarUtils CalendarInterval interface) ────────────────────

export interface MockTimeSlot {
  startTime: Date;
  endTime: Date;
  isAvailable: boolean;
  isBooked: boolean;
  isPartiallyBooked?: boolean;
  isConflicting?: boolean;
  originalSlot?: any;
  appointmentDetails?: any[];
}

export function makeTimeSlot(
  startISO: string,
  endISO: string,
  overrides: Partial<MockTimeSlot> = {},
): MockTimeSlot {
  return {
    startTime: new Date(startISO),
    endTime: new Date(endISO),
    isAvailable: true,
    isBooked: false,
    ...overrides,
  };
}

/** Generate N consecutive 30-min TimeSlots starting at a given time */
export function makeConsecutiveTimeSlots(
  startISO: string,
  count: number,
  overrides: Partial<MockTimeSlot> = {},
): MockTimeSlot[] {
  const slots: MockTimeSlot[] = [];
  let current = new Date(startISO);
  for (let i = 0; i < count; i++) {
    const end = new Date(current.getTime() + 30 * 60 * 1000);
    slots.push({
      startTime: new Date(current),
      endTime: new Date(end),
      isAvailable: true,
      isBooked: false,
      ...overrides,
    });
    current = end;
  }
  return slots;
}

/** Generate a week of availability: 1-hour blocks at a given hour each weekday */
export function makeWeekOfAvailability(
  weekStartISO: string,
  hourUTC: number,
  daysCount: number = 5,
): MockTimeSlot[] {
  const slots: MockTimeSlot[] = [];
  const weekStart = new Date(weekStartISO);

  for (let d = 0; d < 7 && slots.length / 2 < daysCount; d++) {
    const day = new Date(weekStart);
    day.setDate(weekStart.getDate() + d);
    const dayOfWeek = day.getDay();
    // Skip weekends
    if (dayOfWeek === 0 || dayOfWeek === 6) continue;

    const start = new Date(day);
    start.setUTCHours(hourUTC, 0, 0, 0);
    const mid = new Date(start.getTime() + 30 * 60 * 1000);
    const end = new Date(start.getTime() + 60 * 60 * 1000);

    slots.push(
      makeTimeSlot(start.toISOString(), mid.toISOString()),
      makeTimeSlot(mid.toISOString(), end.toISOString()),
    );
  }

  return slots;
}

// ─── Subscription / Plan Mocks ──────────────────────────────────────────────

export function makeSubscriptionPlan(overrides: Record<string, any> = {}) {
  return {
    id: "plan-1",
    title: "Test Plan",
    sessionsPerWeek: 2,
    sessionDurationInHours: 1,
    durationInMonths: 1,
    ...overrides,
  };
}

export function makeSubscription(overrides: Record<string, any> = {}) {
  return {
    id: "sub-1",
    schedulingPeriodStartsAt: new Date("2025-01-06T00:00:00.000Z"), // Monday
    schedulingPeriodEndsAt: new Date("2025-02-02T23:59:59.000Z"), // Sunday
    subscriptionPlan: makeSubscriptionPlan(),
    requestedBy: {
      user: { name: "Test User", id: "user-1" },
    },
    ...overrides,
  };
}

// ─── Appointment Mocks ──────────────────────────────────────────────────────

/**
 * #1554 — one held call is ONE occurrence row spanning its 30-minute
 * intervals, so a list of interval starts collapses into a single row from the
 * earliest start to the latest start plus one interval.
 */
export function makeAppointmentWithSlots(
  id: string,
  slotStartISOs: string[],
): {
  id: string;
  occurrences: { id: string; startsAt: Date; endsAt: Date }[];
} {
  if (slotStartISOs.length === 0) return { id, occurrences: [] };
  const starts = slotStartISOs.map((iso) => new Date(iso).getTime());
  return {
    id,
    occurrences: [
      {
        id: `${id}-occ-1`,
        startsAt: new Date(Math.min(...starts)),
        endsAt: new Date(Math.max(...starts) + 30 * 60 * 1000),
      },
    ],
  };
}

// ─── Prisma Mock Factory ────────────────────────────────────────────────────

export function makeMockPrisma(
  subscriptionData: any = null,
  appointmentData: any[] = [],
) {
  return {
    subscription: {
      findUnique: jest.fn().mockResolvedValue(subscriptionData),
    },
    appointment: {
      findMany: jest.fn().mockResolvedValue(appointmentData),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    // #1554 — the validator counts occurrence rows, so flatten the wrappers.
    appointmentOccurrence: {
      findMany: jest.fn().mockResolvedValue(
        appointmentData.flatMap(
          (appointment: { id: string; occurrences?: object[] }) =>
            (appointment.occurrences ?? []).map((occurrence) => ({
              ...occurrence,
              appointmentId: appointment.id,
            })),
        ),
      ),
    },
  } as any;
}

// ─── Consultant Mock Data ───────────────────────────────────────────────────

export function makeConsultantData(overrides: Record<string, any> = {}): {
  userId: string;
  scheduleType: string;
  availabilityWindowsWeekly: any[];
  availabilityWindowsCustom: any[];
  timezone?: string;
} {
  return {
    userId: "consultant-user-1",
    scheduleType: ScheduleType.WEEKLY,
    availabilityWindowsWeekly: [],
    availabilityWindowsCustom: [],
    ...overrides,
  };
}

export function makeWeeklyAvailabilitySlot(
  day: DayOfWeek,
  startHourUTC: number,
  endHourUTC: number,
  utcOffsetMinutes: number = 0,
  endDay?: DayOfWeek,
) {
  return {
    id: `weekly-${day}-${startHourUTC}`,
    startDay: day,
    startTimeUtc: startHourUTC * 60, // minutes since midnight UTC
    endDay: endDay ?? day,
    endTimeUtc: endHourUTC * 60, // minutes since midnight UTC
    utcOffsetMinutes,
  };
}

export function makeCustomAvailabilitySlot(startISO: string, endISO: string) {
  return {
    id: `custom-${startISO}`,
    startsAt: new Date(startISO),
    endsAt: new Date(endISO),
  };
}
