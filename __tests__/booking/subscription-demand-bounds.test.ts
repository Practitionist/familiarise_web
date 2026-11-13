/**
 * @jest-environment node
 */

/**
 * The two bounds on plan sales. Worked example: an expert in Asia/Kolkata
 * publishes six one-hour weekly slots (Mon–Sat 10:00–11:00) and sells a
 * three-a-week plan. Two sold-but-unplaced plans take all six hours, so the
 * third buyer is refused before paying; an expert-set client limit refuses a
 * new client at the limit but never a buyer who already holds a plan.
 */

jest.mock("../../utils/appointmentlock", () => {
  const actual = jest.requireActual("../../utils/appointmentlock");
  return { ...actual, lockRequestCap: jest.fn() };
});

import { assessFeasibility, type TimeSpan } from "@/lib/booking/feasibility";
import {
  assertPlanClientRoom,
  heldPlanWhere,
  holdsPlanWith,
  planClientsFull,
  readUnplacedPlanSessions,
} from "@/lib/booking/plan-demand";
import { lockExpertPlanSales } from "@/lib/payments/checkout/locks";
import {
  isBusinessErrorCode,
  classifyError,
} from "@/lib/errors/classification/payment-error-classification";
import type { Tx } from "@/lib/prisma";
import {
  EventCheckoutBusyError,
  lockRequestCap,
  RequestCapBusyError,
} from "@/utils/appointmentlock";
import { buildDeadHoldFilter } from "@/utils/scheduling-engine/occupancyPolicy";
import {
  maxActivePlanClientsSchema,
  parsePlanClientLimitInput,
  shownPlanClientLimit,
} from "@/schemas/plan-clients";
import { subscriptionCheckoutBlocked } from "@/schemas/plan-feasibility";
import { planClientsLine } from "@/app/dashboard/consultant/[consultantId]/(features)/settings/sections/BookingRequestsSection";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// Monday 2026-11-16 00:00 IST.
const MONDAY = Date.parse("2026-11-15T18:30:00Z");
const NOW = new Date(MONDAY - DAY);
/** One 10:00–11:00 window on each of the first `days` days of the week. */
const hourWindows = (days: number): TimeSpan[] =>
  Array.from({ length: days }, (_, d) => ({
    startMs: MONDAY + d * DAY + 10 * HOUR,
    endMs: MONDAY + d * DAY + 11 * HOUR,
  }));
/** A one-hour, three-a-week buyer's first-week room around other plans' owed sessions. */
const room = (
  windows: TimeSpan[],
  owed: { sessionMinutes: number; count: number }[],
) =>
  assessFeasibility({
    windows,
    busy: [],
    zone: "Asia/Kolkata",
    sessionMinutes: 60,
    sessionsPerWeek: 3,
    perDayCap: 1,
    notBeforeMs: MONDAY,
    weeks: 1,
    reservedSessions: owed.map((o) => ({ week: 0, ...o })),
  }).weeks[0].placeable;

/** A held plan row as `readUnplacedPlanSessions` selects it. */
function plan(placedStarts: number[] = []) {
  return {
    schedulingPeriodStartsAt: new Date(MONDAY),
    schedulingTimezone: "Asia/Kolkata",
    planEndsAt: new Date(MONDAY + 28 * DAY),
    sessionsTotal: 12,
    sessionsPerWeek: 3,
    sessionMinutes: 60,
    sessionsRefunded: 0,
    subscriptionPlan: {
      totalSessions: 12,
      sessionsPerWeek: 3,
      durationInMonths: 1,
      sessionDurationInHours: 1,
    },
    appointment: {
      occurrences: placedStarts.map((startMs) => ({
        startsAt: new Date(startMs),
        endsAt: new Date(startMs + HOUR),
        completionStatus: "SCHEDULED",
        isTentative: false,
        deletedAt: null,
        hostCancelledAt: null,
      })),
    },
  };
}

function fakeDb(rows: unknown[], limit: number | null = null) {
  const findMany = jest.fn().mockResolvedValue(rows);
  const findUnique = jest
    .fn()
    .mockResolvedValue({ maxActivePlanClients: limit });
  return {
    db: {
      subscription: { findMany },
      consultantProfile: { findUnique },
    } as unknown as Tx,
    findMany,
  };
}

describe("bound 1: checkout counts sold-but-unplaced plans", () => {
  it("refuses the third of three buyers on six weekly hours", () => {
    const threeAWeek = { sessionMinutes: 60, count: 3 };
    expect(room(hourWindows(6), [])).toBe(3);
    expect(room(hourWindows(6), [threeAWeek])).toBe(3);
    expect(room(hourWindows(6), [threeAWeek, threeAWeek])).toBe(0);
  });

  it("never counts room that owed sessions leave too fragmented to use", () => {
    // Seven one-hour windows; another plan owes a 30-minute session each day.
    expect(room(hourWindows(7), [{ sessionMinutes: 30, count: 7 }])).toBe(0);
    expect(room(hourWindows(7), [{ sessionMinutes: 30, count: 4 }])).toBe(3);
  });

  it("reserves each held plan's unplaced cadence, not its placed sessions", async () => {
    const placedMonday = MONDAY + 10 * HOUR;
    const { db, findMany } = fakeDb([plan(), plan([placedMonday])]);
    const owed = await readUnplacedPlanSessions(db, {
      consultantProfileId: "cp-1",
      weekStarts: [MONDAY, MONDAY + 7 * DAY],
      excludeSubscriptionIds: ["own-renewed-plan"],
      now: NOW,
    });
    // 3 unplaced, and 3 − 1 placed (which is busy time already) = 2.
    expect(owed).toEqual([
      { week: 0, sessionMinutes: 60, count: 3 },
      { week: 0, sessionMinutes: 60, count: 2 },
    ]);
    const where = findMany.mock.calls[0][0].where;
    // A renewal is never blocked by the plan it renews.
    expect(where.id).toEqual({ notIn: ["own-renewed-plan"] });
    // A lapsed checkout hold stops counting on its own expiry.
    expect(where.NOT).toEqual({ appointment: buildDeadHoldFilter(NOW) });
  });

  it("maps a busy request-cap key to the retried plan-checkout answer", async () => {
    (lockRequestCap as jest.Mock).mockRejectedValueOnce(
      new RequestCapBusyError(),
    );
    await expect(lockExpertPlanSales("cp-1")).rejects.toBeInstanceOf(
      EventCheckoutBusyError,
    );
    expect(lockRequestCap).toHaveBeenCalledWith("cp-1", 45_000);
  });
});

describe("bound 2: an expert-set limit on active plan clients", () => {
  const clients = (...ids: string[]) =>
    ids.map((requestedById) => ({ requestedById }));
  const check = (rows: unknown[], limit: number | null, buyer: string) =>
    assertPlanClientRoom(fakeDb(rows, limit).db, {
      consultantProfileId: "cp-1",
      consulteeProfileId: buyer,
      now: NOW,
    });

  it("refuses a new client at the limit with a typed, customer-safe 409", async () => {
    const error = await check(clients("a", "b"), 2, "c").catch((e) => e);
    expect(error).toMatchObject({ code: "PLAN_CLIENTS_FULL", httpStatus: 409 });
    expect(isBusinessErrorCode("PLAN_CLIENTS_FULL")).toBe(true);
    expect(classifyError(error).httpStatus).toBe(409);
    expect(error.message).not.toMatch(/[A-Z]{2,}_[A-Z]/);
  });

  it("allows below the limit, with no limit, and a current client's renewal", async () => {
    await expect(check(clients("a", "b"), 3, "c")).resolves.toBeUndefined();
    await expect(check(clients("a", "b"), null, "c")).resolves.toBeUndefined();
    // Lowered below the count: existing clients keep buying, nobody new does.
    await expect(check(clients("a", "b"), 1, "a")).resolves.toBeUndefined();
    await expect(check(clients("a", "b"), 1, "c")).rejects.toMatchObject({
      code: "PLAN_CLIENTS_FULL",
    });
  });

  it("counts distinct buyers whose plan still holds them", async () => {
    const { db, findMany } = fakeDb(clients("a"), 1);
    await expect(planClientsFull(db, "cp-1", NOW)).resolves.toBe(true);
    expect(findMany.mock.calls[0][0]).toMatchObject({
      where: heldPlanWhere("cp-1", NOW),
      distinct: ["requestedById"],
    });
    await expect(planClientsFull(fakeDb([], 1).db, "cp-1", NOW)).resolves.toBe(
      false,
    );
    await expect(
      planClientsFull(fakeDb(clients("a"), null).db, "cp-1", NOW),
    ).resolves.toBe(false);
  });

  it("answers per viewer whether they already hold a plan with the expert", async () => {
    const count = jest.fn().mockResolvedValue(1);
    const db = { subscription: { count } } as unknown as Tx;
    await expect(holdsPlanWith(db, "cp-1", "user-a", NOW)).resolves.toBe(true);
    expect(count.mock.calls[0][0].where).toEqual({
      ...heldPlanWhere("cp-1", NOW),
      requestedBy: { userId: "user-a" },
    });
  });

  it("checkout's pay button follows the server's per-viewer answer", () => {
    const read = {
      verdict: "ok" as const,
      firstWeekPlaceable: 3,
      sessionsPerWeek: 3,
      notice: null,
    };
    expect(subscriptionCheckoutBlocked({ ...read, fullyBooked: true })).toBe(
      true,
    );
    // An existing client is answered fullyBooked: false, so they can still pay.
    expect(subscriptionCheckoutBlocked({ ...read, fullyBooked: false })).toBe(
      false,
    );
    expect(subscriptionCheckoutBlocked(null)).toBe(false);
  });

  it("validates the setting: a whole number of at least 1, or blank for none", () => {
    expect(maxActivePlanClientsSchema.safeParse(5).success).toBe(true);
    expect(maxActivePlanClientsSchema.safeParse(null).success).toBe(true);
    for (const bad of [0, -1, 2.5, 501]) {
      expect(maxActivePlanClientsSchema.safeParse(bad).success).toBe(false);
    }
    expect(parsePlanClientLimitInput("")).toEqual({ ok: true, value: null });
    expect(parsePlanClientLimitInput(" 7 ")).toEqual({ ok: true, value: 7 });
    // Refused with a reason, never rounded or clamped into range.
    const reasons = ["0", "-3", "2.7", "501", "abc"].map((raw) =>
      parsePlanClientLimitInput(raw),
    );
    for (const reason of reasons) {
      expect(reason).toEqual({
        ok: false,
        error: expect.stringContaining("whole number from 1 to 500"),
      });
    }
    // The count line never follows a partial or refused entry.
    expect(shownPlanClientLimit("501", 5)).toBe(5);
    expect(shownPlanClientLimit("1e", 5)).toBe(5);
    expect(shownPlanClientLimit("7", 5)).toBe(7);
    expect(shownPlanClientLimit("", 5)).toBeNull();
    expect(planClientsLine(3, 5)).toBe("3 of 5 active plan clients");
    expect(planClientsLine(1, null)).toBe("1 active plan client");
  });
});
