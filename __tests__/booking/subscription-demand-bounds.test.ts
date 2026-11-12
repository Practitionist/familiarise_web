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

import fs from "node:fs";
import path from "node:path";

import { assessFeasibility, type TimeSpan } from "@/lib/booking/feasibility";
import {
  assertPlanClientRoom,
  heldPlanWhere,
  planClientsFull,
  readUnplacedPlanMinutes,
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
import { maxActivePlanClientsSchema } from "@/schemas/plan-clients";
import {
  parseMaxActivePlanClients,
  planClientsLine,
} from "@/app/dashboard/consultant/[consultantId]/(features)/settings/sections/BookingRequestsSection";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// Monday 2026-11-16 00:00 IST.
const MONDAY = Date.parse("2026-11-15T18:30:00Z");
const NOW = new Date(MONDAY - DAY);
const sixSlots: TimeSpan[] = [0, 1, 2, 3, 4, 5].map((d) => ({
  startMs: MONDAY + d * DAY + 10 * HOUR,
  endMs: MONDAY + d * DAY + 11 * HOUR,
}));
const room = (reservedMinutes: number) =>
  assessFeasibility({
    windows: sixSlots,
    busy: [],
    zone: "Asia/Kolkata",
    sessionMinutes: 60,
    sessionsPerWeek: 3,
    perDayCap: 1,
    notBeforeMs: MONDAY,
    weeks: 1,
    reservedMinutesByWeek: [reservedMinutes],
  }).weeks[0].placeable;

/** A held plan row as `readUnplacedPlanMinutes` selects it. */
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
    expect(room(0)).toBe(3);
    expect(room(3 * 60)).toBe(3);
    expect(room(6 * 60)).toBe(0);
  });

  it("reserves each held plan's unplaced cadence, not its placed sessions", async () => {
    const placedMonday = MONDAY + 10 * HOUR;
    const { db, findMany } = fakeDb([plan(), plan([placedMonday])]);
    const minutes = await readUnplacedPlanMinutes(db, {
      consultantProfileId: "cp-1",
      weekStarts: [MONDAY, MONDAY + 7 * DAY],
      excludeSubscriptionIds: ["own-renewed-plan"],
      now: NOW,
    });
    // 3 unplaced + (3 − 1 placed, which is busy time already) = 5 sessions.
    expect(minutes).toEqual([5 * 60]);
    const where = findMany.mock.calls[0][0].where;
    // A renewal is never blocked by the plan it renews.
    expect(where.id).toEqual({ notIn: ["own-renewed-plan"] });
    // A lapsed checkout hold stops counting on its own expiry.
    expect(where.NOT).toEqual({ appointment: buildDeadHoldFilter(NOW) });
  });

  it("serialises two buyers of one expert on the request-cap key", async () => {
    (lockRequestCap as jest.Mock).mockRejectedValueOnce(
      new RequestCapBusyError(),
    );
    await expect(lockExpertPlanSales("cp-1")).rejects.toBeInstanceOf(
      EventCheckoutBusyError,
    );
    expect(lockRequestCap).toHaveBeenCalledWith("cp-1", 45_000);
    // Lock order: event checkout, then this consultant-tier key, then the consultee.
    const src = fs.readFileSync(
      path.join(process.cwd(), "lib/payments/checkout/orchestrate.ts"),
      "utf8",
    );
    const eventPath = src.slice(
      src.indexOf("lock = await acquireCheckoutLock("),
    );
    expect(eventPath.indexOf("lockExpertPlanSales(")).toBeLessThan(
      eventPath.indexOf("lockConsulteeBooking("),
    );
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

  it("validates the setting: a whole number of at least 1, or blank for none", () => {
    expect(maxActivePlanClientsSchema.safeParse(5).success).toBe(true);
    expect(maxActivePlanClientsSchema.safeParse(null).success).toBe(true);
    for (const bad of [0, -1, 2.5, 501]) {
      expect(maxActivePlanClientsSchema.safeParse(bad).success).toBe(false);
    }
    expect(parseMaxActivePlanClients("", 4)).toBeNull();
    expect(parseMaxActivePlanClients("0", null)).toBe(1);
    expect(parseMaxActivePlanClients("abc", 4)).toBe(4);
    expect(planClientsLine(3, 5)).toBe("3 of 5 active plan clients");
    expect(planClientsLine(1, null)).toBe("1 active plan client");
  });
});
