/**
 * A plan's earnings wait for an unconfirmed learner absence, on real Postgres:
 * while one session of the plan reads LEARNER_ABSENT with no confirmation, the
 * release run leaves every dated tranche and the host organisation's earning
 * PENDING; once the verdict is confirmed, the next run releases them all.
 */
import { randomUUID } from "node:crypto";
import prisma from "../../../lib/prisma";
import { releaseEarningsFromHold } from "../../../scripts/earnings/release-earnings";
import { HOUR_MS, seedConsultee, seedHost } from "./harness";

const DAY_MS = 24 * HOUR_MS;
const PRICE = 100_000;

/** A live 4-session plan, every session delivered on its own day, the last one learner-absent and unconfirmed; both tranches and the organisation earning are past their holds. */
async function seedPlanWithLearnerAbsence() {
  const host = await seedHost();
  const buyer = await seedConsultee();
  const now = Date.now();
  const org = await prisma.organization.create({
    data: { name: "Host org", slug: `db-tier-${randomUUID()}` },
  });
  const plan = await prisma.subscriptionPlan.create({
    data: {
      title: "Twice-weekly mentoring",
      price: BigInt(PRICE),
      totalSessions: 4,
      sessionsPerWeek: 2,
      durationInMonths: 1,
      consultantProfileId: host.consultantProfileId,
    },
  });
  const subscription = await prisma.subscription.create({
    data: {
      subscriptionPlanId: plan.id,
      requestedById: buyer.consulteeProfileId,
      status: "APPROVED",
      bookingSource: "DIRECT_CHECKOUT",
      sessionsTotal: 4,
      schedulingPeriodStartsAt: new Date(now - 20 * DAY_MS),
      schedulingPeriodEndsAt: new Date(now + 10 * DAY_MS),
      planEndsAt: new Date(now + 10 * DAY_MS),
      schedulingTimezone: "UTC",
    },
  });
  const appointment = await prisma.appointment.create({
    data: { appointmentType: "SUBSCRIPTION", subscriptionId: subscription.id },
  });
  let absentId = "";
  // One hour a day on four different days, so no two sessions of the host overlap.
  for (let i = 0; i < 4; i++) {
    const startsAt = new Date(now - (10 - i) * DAY_MS);
    const absent = i === 3;
    const row = await prisma.appointmentOccurrence.create({
      data: {
        appointmentId: appointment.id,
        ordinal: i + 1,
        startsAt,
        endsAt: new Date(startsAt.getTime() + HOUR_MS),
        isTentative: false,
        consultantProfileId: host.consultantProfileId,
        completionStatus: "COMPLETED",
        completedAt: startsAt,
        outcome: absent ? "LEARNER_ABSENT" : "HELD",
        outcomeAt: startsAt,
      },
    });
    if (absent) absentId = row.id;
  }
  const payment = await prisma.payment.create({
    data: {
      amount: BigInt(PRICE),
      originalAmount: BigInt(PRICE),
      paymentMethod: "card",
      paymentIntent: `order_dbtier_${randomUUID()}`,
      paymentGateway: "RAZORPAY",
      paymentStatus: "SUCCEEDED",
      userId: buyer.userId,
      appointmentId: appointment.id,
      isMockPayment: true,
      legs: { create: [{ source: "CARD", amountPaise: BigInt(PRICE) }] },
      expiresAt: null,
    },
  });
  const pastHold = new Date(now - DAY_MS);
  const trancheIds: string[] = [];
  for (const cycleOrdinal of [0, 1]) {
    const tranche = await prisma.consultantEarnings.create({
      data: {
        consultantProfileId: host.consultantProfileId,
        paymentId: payment.id,
        grossAmount: BigInt(PRICE / 2),
        platformFeePaise: BigInt(10_000),
        consultantSharePaise: BigInt(35_000),
        cycleOrdinal,
        status: "PENDING",
        holdUntil: pastHold,
      },
    });
    trancheIds.push(tranche.id);
  }
  const orgEarning = await prisma.organizationEarnings.create({
    data: {
      organizationId: org.id,
      paymentId: payment.id,
      grossAmountPaise: BigInt(PRICE),
      platformFeePaise: BigInt(20_000),
      orgSharePaise: BigInt(10_000),
      consultantSharePaise: BigInt(70_000),
      status: "PENDING",
      holdUntil: pastHold,
    },
  });
  return { absentId, trancheIds, orgEarningId: orgEarning.id };
}

async function statuses(s: { trancheIds: string[]; orgEarningId: string }) {
  const tranches = await prisma.consultantEarnings.findMany({
    where: { id: { in: s.trancheIds } },
    orderBy: { cycleOrdinal: "asc" },
    select: { status: true },
  });
  const org = await prisma.organizationEarnings.findUniqueOrThrow({
    where: { id: s.orgEarningId },
    select: { status: true },
  });
  return [...tranches.map((t) => t.status), org.status];
}

it("no tranche of a plan, nor its host organisation's earning, is released while a session's learner absence is unconfirmed; all are once it is confirmed", async () => {
  const seeded = await seedPlanWithLearnerAbsence();

  await releaseEarningsFromHold();
  expect(await statuses(seeded)).toEqual(["PENDING", "PENDING", "PENDING"]);

  await prisma.appointmentOccurrence.update({
    where: { id: seeded.absentId },
    data: { outcomeConfirmedAt: new Date() },
  });
  await releaseEarningsFromHold();
  expect(await statuses(seeded)).toEqual(["READY", "READY", "READY"]);
});
