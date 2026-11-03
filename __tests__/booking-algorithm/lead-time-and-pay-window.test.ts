/**
 * Server-placed times keep the buyer's lead time (15 min) once a booking is
 * paid and 2 h while the client still has to pay; the pay window never runs
 * past 15 min before the first session, and a window under 30 min is refused.
 */

import "./setup";

jest.mock("../../lib/redis", () => ({
  __esModule: true,
  default: {},
  withCircuitBreaker: (fn: () => unknown) => fn(),
  checkRedisHealth: jest.fn().mockResolvedValue(true),
}));

import {
  leadTimeFor,
  UNPAID_APPROVAL_LEAD_TIME_MS,
} from "@/lib/booking/lead-time";
import {
  MIN_PAY_WINDOW_MS,
  payWindowEnd,
} from "@/lib/payments/operations/approval-payment";
import { bestBlockForSingleSession } from "@/lib/booking/allocation/search/blocks";
import { ScheduleValidationService } from "@/utils/scheduling-engine/ScheduleValidationService";
import { ScheduleType } from "@prisma/client";

const MIN = 60_000;
const HOUR = 60 * MIN;

describe("leadTimeFor", () => {
  it("is 15 minutes settled and 2 hours unpaid", () => {
    expect(leadTimeFor({ settled: true })).toBe(15 * MIN);
    expect(leadTimeFor({ settled: false })).toBe(2 * HOUR);
    expect(UNPAID_APPROVAL_LEAD_TIME_MS).toBe(2 * HOUR);
  });
});

describe("payWindowEnd", () => {
  const now = new Date("2030-01-01T10:00:00Z");

  it("is 24 hours when the first session is far away", () => {
    const first = new Date("2030-01-05T10:00:00Z");
    expect(payWindowEnd(now, first).getTime()).toBe(now.getTime() + 24 * HOUR);
  });

  it("closes 15 minutes before a first session inside the day", () => {
    const first = new Date("2030-01-01T15:00:00Z");
    expect(payWindowEnd(now, first).toISOString()).toBe(
      "2030-01-01T14:45:00.000Z",
    );
  });

  it("leaves under 30 minutes for a session 40 minutes away: the mint is refused", () => {
    const first = new Date(now.getTime() + 40 * MIN);
    expect(payWindowEnd(now, first).getTime() - now.getTime()).toBeLessThan(
      MIN_PAY_WINDOW_MS,
    );
  });

  it("is 24 hours when nothing is placed yet", () => {
    expect(payWindowEnd(now, null).getTime()).toBe(now.getTime() + 24 * HOUR);
  });
});

describe("validator lead time", () => {
  const consultant = {
    userId: "u-1",
    scheduleType: ScheduleType.CUSTOM,
    availabilityWindowsWeekly: [],
    availabilityWindowsCustom: [],
  };
  const service = new ScheduleValidationService({
    appointment: { findMany: jest.fn().mockResolvedValue([]) },
  } as never);

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2030-01-01T10:00:00Z"));
  });
  afterEach(() => jest.useRealTimers());

  it("refuses a time 1 hour out for an unpaid approval, as plain TOO_SOON", async () => {
    const result = await service.validate(
      "consultation",
      "c-1",
      [new Date("2030-01-01T11:00:00Z")],
      consultant,
      { durationInHours: 0.5 },
      [],
      { overrideAvailabilityWindow: true, leadTimeMs: 2 * HOUR },
    );
    expect(result.isValid).toBe(false);
    expect(result.errors[0]).toMatch(/^\[TOO_SOON\]/);
  });

  it("refuses a time 10 seconds out even for a settled booking", async () => {
    const result = await service.validate(
      "consultation",
      "c-1",
      [new Date("2030-01-01T10:00:10Z")],
      consultant,
      { durationInHours: 0.5 },
      [],
      { overrideAvailabilityWindow: true },
    );
    expect(result.isValid).toBe(false);
  });
});

describe("single-session search", () => {
  const row = (startsAt: string, endsAt: string) => ({
    id: "row",
    startsAt: new Date(startsAt),
    endsAt: new Date(endsAt),
  });

  it("starts no sooner than the lead-shifted clock it is handed", () => {
    // 10:05 now + 2 h lead: the search clock is 12:05, so 12:30 is first.
    const consultant = {
      userId: "u-1",
      scheduleType: ScheduleType.CUSTOM,
      availabilityWindowsWeekly: [],
      availabilityWindowsCustom: [
        row("2030-01-01T09:00:00Z", "2030-01-01T17:00:00Z"),
      ],
    };
    const block = bestBlockForSingleSession(
      "consultation",
      consultant,
      2,
      new Set(),
      new Date("2030-01-01T12:05:00Z"),
      [],
      consultant.availabilityWindowsCustom,
    );
    expect(block?.[0].toISOString()).toBe("2030-01-01T12:30:00.000Z");
  });

  it("keeps the rest of today's running weekly row (earliest fit)", () => {
    const consultant = {
      userId: "u-1",
      scheduleType: ScheduleType.WEEKLY,
      availabilityWindowsWeekly: [
        {
          id: "w-1",
          localStartDay: "TUESDAY",
          localStartMinutes: 9 * 60,
          localEndDay: "TUESDAY",
          localEndMinutes: 17 * 60,
          timezone: "UTC",
        },
      ],
      availabilityWindowsCustom: [],
    };
    // 2030-01-01 is a Tuesday; 10:20 is inside the 09:00–17:00 row.
    const block = bestBlockForSingleSession(
      "consultation",
      consultant as never,
      2,
      new Set(),
      new Date("2030-01-01T10:20:00Z"),
      consultant.availabilityWindowsWeekly as never,
      [],
    );
    expect(block?.[0].toISOString()).toBe("2030-01-01T10:30:00.000Z");
  });
});
