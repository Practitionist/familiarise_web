/**
 * The roll-forward against real Postgres: two overlapping runs never place a
 * session twice, a slot another buyer already holds is skipped while the rest
 * land (no throw), and the per-host exclusion constraint still refuses a
 * cross-event overlap with a session the roll-forward placed.
 */
import prisma from "../../../lib/prisma";
import {
  HOUR_MS,
  futureAt,
  overlappingOccupyingPairs,
  seedConsultee,
  seedHost,
  seedOneToOne,
  seedPaidSubscription,
  type SeededHost,
} from "./harness";

jest.mock("../../../lib/novu", () => {
  const noop = jest.fn(async () => []);
  return new Proxy(
    {},
    { get: (_target, prop) => (prop === "__esModule" ? true : noop) },
  );
});

import {
  REGULAR_TIME_PLAN_SELECT,
  placeRegularWeeks,
  readRegularTimeView,
} from "../../../lib/booking/regular-time/service";
import {
  subscriptionEntitlement,
  soldTermsOf,
} from "../../../lib/booking/entitlement";

const DAY_MS = 24 * HOUR_MS;

/** 06:00–22:00 UTC on each of the next 35 days. */
async function publishDays(host: SeededHost) {
  await prisma.consultantProfile.update({
    where: { id: host.consultantProfileId },
    data: { verificationStatus: "VERIFIED", scheduleType: "CUSTOM" },
  });
  await prisma.availabilityWindowCustom.createMany({
    data: Array.from({ length: 35 }, (_, i) => ({
      consultantProfileId: host.consultantProfileId,
      startsAt: futureAt(i + 1, 6),
      endsAt: futureAt(i + 1, 22),
    })),
  });
}

/** A paid, approved 2-a-week plan starting tomorrow with a Regular time at 10:00 UTC on days 1 and 3 of each week. */
async function regularPlan() {
  const host = await seedHost();
  await publishDays(host);
  const start = futureAt(1, 0);
  const { subscriptionId, appointmentId } = await seedPaidSubscription(
    host,
    await seedConsultee(),
    start,
    { sessionsPerWeek: 2, totalSessions: 8, firstCycleDays: 7 },
  );
  await prisma.subscription.update({
    where: { id: subscriptionId },
    data: { status: "APPROVED", sessionsPerWeek: 2, sessionMinutes: 60 },
  });
  const iso = (d: Date) => (d.getUTCDay() === 0 ? 7 : d.getUTCDay());
  await prisma.regularTime.createMany({
    data: [start, new Date(start.getTime() + 2 * DAY_MS)].map((d) => ({
      subscriptionId,
      weekday: iso(d),
      localStartMinutes: 600,
      timezone: "UTC",
      validFrom: start,
      createdByUserId: host.userId,
    })),
  });
  return { host, subscriptionId, appointmentId, start };
}

const readPlan = async (id: string) => {
  const plan = await prisma.subscription.findUnique({
    where: { id },
    select: REGULAR_TIME_PLAN_SELECT,
  });
  if (!plan) throw new Error("plan missing");
  return plan;
};

const horizonWeeks = async (id: string) => {
  const plan = await readPlan(id);
  return subscriptionEntitlement({
    ...soldTermsOf(plan),
    occurrences: plan.appointment?.occurrences ?? [],
    schedulingPeriodStartsAt: plan.schedulingPeriodStartsAt,
    schedulingTimezone: plan.schedulingTimezone,
    planEndsAt: plan.planEndsAt,
    hasRegularTime: true,
  }).horizon.map((w) => w.weekIndex);
};

const liveSessions = (subscriptionId: string) =>
  prisma.appointmentOccurrence.count({
    where: {
      appointment: { subscriptionId },
      deletedAt: null,
      isTentative: false,
      completionStatus: "SCHEDULED",
    },
  });

it("T17: two overlapping roll-forwards never place a session twice", async () => {
  const { host, subscriptionId } = await regularPlan();
  const weeks = await horizonWeeks(subscriptionId);
  const plan = await readPlan(subscriptionId);
  const now = new Date();
  const results = await Promise.allSettled([
    placeRegularWeeks(plan, weeks, { now }),
    placeRegularWeeks(plan, weeks, { now }),
  ]);
  expect(results.every((r) => r.status === "fulfilled")).toBe(true);
  // 4 open weeks × 2 a week, all inside the 30-day plan.
  expect(await liveSessions(subscriptionId)).toBe(8);
  expect(await overlappingOccupyingPairs(host.consultantProfileId)).toBe(0);
  const history = await prisma.bookingStatusHistory.findMany({
    where: { entity: "SUBSCRIPTION", entityId: subscriptionId },
    select: { reason: true },
  });
  expect(history.map((h) => h.reason)).toContain("schedule:regular");

  // A third, later run finds every slot held and places nothing.
  const again = await placeRegularWeeks(await readPlan(subscriptionId), weeks, {
    now: new Date(),
  });
  expect(again.placed).toBe(0);
  expect(await liveSessions(subscriptionId)).toBe(8);
}, 120_000);

it("T16: a slot another buyer already holds is skipped as TAKEN; the others land; no throw", async () => {
  const { host, subscriptionId, start } = await regularPlan();
  const taken = new Date(start.getTime() + 7 * DAY_MS + 10 * HOUR_MS);
  await seedOneToOne(
    "consultation",
    host,
    await seedConsultee(),
    { startsAt: taken, endsAt: new Date(taken.getTime() + HOUR_MS) },
    { status: "SCHEDULED", isTentative: false },
  );
  const weeks = await horizonWeeks(subscriptionId);
  const out = await placeRegularWeeks(await readPlan(subscriptionId), weeks, {
    now: new Date(),
  });
  expect(out.placed).toBe(7);
  expect(await liveSessions(subscriptionId)).toBe(7);
  expect(await overlappingOccupyingPairs(host.consultantProfileId)).toBe(0);
  const view = await readRegularTimeView(await readPlan(subscriptionId));
  const reasons = view.weeks.flatMap((w) =>
    w.conflicts.map((c) => [c.reason, c.startsAt.toISOString()]),
  );
  expect(reasons).toContainEqual(["TAKEN", taken.toISOString()]);
}, 120_000);

it("T24: the exclusion constraint refuses a cross-event overlap with a roll-forward session", async () => {
  const { host, subscriptionId } = await regularPlan();
  await placeRegularWeeks(
    await readPlan(subscriptionId),
    await horizonWeeks(subscriptionId),
    { now: new Date() },
  );
  const placed = await prisma.appointmentOccurrence.findFirstOrThrow({
    where: { appointment: { subscriptionId }, deletedAt: null },
    orderBy: { startsAt: "asc" },
  });
  const other = await seedOneToOne(
    "consultation",
    host,
    await seedConsultee(),
    {
      startsAt: new Date(placed.startsAt.getTime() + 20 * DAY_MS),
      endsAt: new Date(placed.startsAt.getTime() + 20 * DAY_MS + HOUR_MS),
    },
    { status: "SCHEDULED", isTentative: false },
  );
  await expect(
    prisma.appointmentOccurrence.create({
      data: {
        appointmentId: other.appointmentId,
        ordinal: 2,
        startsAt: new Date(placed.startsAt.getTime() + 30 * 60_000),
        endsAt: new Date(placed.endsAt.getTime() + 30 * 60_000),
        isTentative: false,
        consultantProfileId: host.consultantProfileId,
        completionStatus: "SCHEDULED",
      },
    }),
  ).rejects.toThrow();
  expect(await overlappingOccupyingPairs(host.consultantProfileId)).toBe(0);
}, 120_000);
