/**
 * The hourly top-up places a plan's open week on its own only when the
 * consultant scheduled the plan with Auto; a plan scheduled by hand is left
 * to its consultant (the week reminder and the one-tap Auto).
 */
import { randomUUID } from "node:crypto";
import prisma from "../../../lib/prisma";
import {
  futureAt,
  HOUR_MS,
  seedConsultee,
  seedHost,
  type SeededConsultee,
  type SeededHost,
} from "./harness";

jest.mock("../../../lib/novu", () => {
  const noop = jest.fn(async () => []);
  return new Proxy(
    {},
    { get: (_target, prop) => (prop === "__esModule" ? true : noop) },
  );
});

import { allocate } from "../../../lib/booking/allocation";
import { SCHEDULE_REASON } from "../../../lib/booking/allocation/schedule-choice";
import { reconcileOccurrenceAvailability } from "../../../scripts/appointments/reconcile-occurrence-availability";

/** A paid 1-a-week plan starting at `start`, awaiting its first week. */
async function paidPlan(
  host: SeededHost,
  subscriber: SeededConsultee,
  start: Date,
) {
  const price = BigInt(400_000);
  const plan = await prisma.subscriptionPlan.create({
    data: {
      title: "Top-up plan",
      price,
      consultantProfileId: host.consultantProfileId,
      sessionsPerWeek: 1,
      durationInMonths: 1,
      sessionDurationInHours: 1,
      totalSessions: 4,
    },
  });
  const subscription = await prisma.subscription.create({
    data: {
      subscriptionPlanId: plan.id,
      requestedById: subscriber.consulteeProfileId,
      status: "PENDING",
      bookingSource: "DIRECT_CHECKOUT",
      schedulingPeriodStartsAt: start,
      schedulingPeriodEndsAt: new Date(start.getTime() + 7 * 24 * HOUR_MS),
      planEndsAt: new Date(start.getTime() + 28 * 24 * HOUR_MS),
      schedulingTimezone: "UTC",
      sessionsTotal: 4,
    },
  });
  const appointment = await prisma.appointment.create({
    data: { appointmentType: "SUBSCRIPTION", subscriptionId: subscription.id },
  });
  await prisma.appointmentParticipant.createMany({
    data: [
      {
        appointmentId: appointment.id,
        userId: host.userId,
        role: "CONSULTANT",
        status: "CONFIRMED",
      },
      {
        appointmentId: appointment.id,
        userId: subscriber.userId,
        role: "CONSULTEE",
        status: "CONFIRMED",
      },
    ],
  });
  await prisma.payment.create({
    data: {
      amount: price,
      originalAmount: price,
      paymentMethod: "card",
      paymentIntent: `order_dbtier_${randomUUID()}`,
      paymentGateway: "RAZORPAY",
      paymentStatus: "SUCCEEDED",
      userId: subscriber.userId,
      appointmentId: appointment.id,
      isMockPayment: true,
      legs: { create: [{ source: "CARD", amountPaise: price }] },
    },
  });
  return subscription.id;
}

const liveSessions = (subscriptionId: string) =>
  prisma.appointmentOccurrence.count({
    where: {
      appointment: { subscriptionId },
      deletedAt: null,
      isTentative: false,
      completionStatus: "SCHEDULED",
    },
  });

const reasons = async (subscriptionId: string) =>
  (
    await prisma.bookingStatusHistory.findMany({
      where: { entity: "SUBSCRIPTION", entityId: subscriptionId },
      orderBy: { createdAt: "asc" },
      select: { reason: true },
    })
  ).map((r) => r.reason);

/** 09:00–12:00 UTC on each of the next three weeks' days. */
async function publishMornings(host: SeededHost) {
  await prisma.consultantProfile.update({
    where: { id: host.consultantProfileId },
    data: { verificationStatus: "VERIFIED", scheduleType: "CUSTOM" },
  });
  await prisma.availabilityWindowCustom.createMany({
    data: Array.from({ length: 21 }, (_, i) => ({
      consultantProfileId: host.consultantProfileId,
      startsAt: futureAt(i + 1, 9),
      endsAt: futureAt(i + 1, 12),
    })),
  });
}

async function scheduledPlan(mode: "auto" | "manual") {
  const host = await seedHost();
  await publishMornings(host);
  const start = futureAt(1, 0);
  const subscriptionId = await paidPlan(host, await seedConsultee(), start);
  const first = futureAt(2, 9);
  const result = await allocate(
    mode === "auto"
      ? { eventType: "subscription", eventId: subscriptionId, mode: "auto" }
      : {
          eventType: "subscription",
          eventId: subscriptionId,
          mode: "manual",
          slots: [
            first.toISOString(),
            new Date(first.getTime() + HOUR_MS / 2).toISOString(),
          ],
        },
  );
  expect(result).toMatchObject({ success: true });
  // Week 1 is full, so week 2 is open; the last attempt is now "rested".
  await prisma.subscription.update({
    where: { id: subscriptionId },
    data: { updatedAt: new Date(Date.now() - 7 * HOUR_MS) },
  });
  return subscriptionId;
}

it("a plan scheduled with Auto gets its open week placed by the sweep", async () => {
  const subscriptionId = await scheduledPlan("auto");
  expect(await reasons(subscriptionId)).toContain(SCHEDULE_REASON.planAuto);
  expect(await liveSessions(subscriptionId)).toBe(1);

  await reconcileOccurrenceAvailability();

  expect(await liveSessions(subscriptionId)).toBe(2);
  expect(await reasons(subscriptionId)).toContain(SCHEDULE_REASON.topUp);
}, 60_000);

it("a plan scheduled by hand is left to its consultant", async () => {
  const subscriptionId = await scheduledPlan("manual");
  expect(await reasons(subscriptionId)).toContain(SCHEDULE_REASON.planByHand);

  await reconcileOccurrenceAvailability();

  expect(await liveSessions(subscriptionId)).toBe(1);
}, 60_000);

it("re-placing a released session with Auto never switches a by-hand plan to the sweep", async () => {
  const subscriptionId = await scheduledPlan("manual");
  // The client released their session ("any time works"): it awaits a new time.
  await prisma.appointmentOccurrence.updateMany({
    where: { appointment: { subscriptionId }, deletedAt: null },
    data: { completionStatus: "RESCHEDULED", isTentative: true },
  });
  const replaced = await allocate({
    eventType: "subscription",
    eventId: subscriptionId,
    mode: "auto",
  });
  expect(replaced).toMatchObject({ success: true });
  expect(await reasons(subscriptionId)).toContain(SCHEDULE_REASON.reschedule);
  expect(await reasons(subscriptionId)).not.toContain(SCHEDULE_REASON.planAuto);
  await prisma.subscription.update({
    where: { id: subscriptionId },
    data: { updatedAt: new Date(Date.now() - 7 * HOUR_MS) },
  });
  const before = await liveSessions(subscriptionId);

  await reconcileOccurrenceAvailability();

  expect(await liveSessions(subscriptionId)).toBe(before);
}, 60_000);
