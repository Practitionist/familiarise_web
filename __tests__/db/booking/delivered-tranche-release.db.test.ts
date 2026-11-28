/**
 * A delivered plan cycle is paid on its own date, on real Postgres: with cycle
 * one delivered and cycle two still on the calendar, completion dates tranche
 * 0 alone, and once that date has passed the release run moves tranche 0 to
 * READY while tranche 1 and the plan's organisation earning stay PENDING. An
 * owed refund on the payment still holds the dated tranche.
 */
import { randomUUID } from "node:crypto";
import prisma from "../../../lib/prisma";
import {
  HOUR_MS,
  seedConsultee,
  seedHost,
  seedPaidSubscription,
} from "./harness";

import { settleSubscriptionCycle } from "../../../lib/booking/subscription-cycle";
import { releaseEarningsFromHold } from "../../../scripts/earnings/release-earnings";

const DAY_MS = 24 * HOUR_MS;

/** A live two-cycle plan, one session a cycle: the first delivered, the second scheduled next week. */
async function seedTwoCyclePlan() {
  const host = await seedHost();
  const buyer = await seedConsultee();
  const periodStart = new Date(Date.now() - 20 * DAY_MS);
  const { subscriptionId, appointmentId } = await seedPaidSubscription(
    host,
    buyer,
    periodStart,
    { sessionsPerWeek: 1, totalSessions: 2 },
  );
  await prisma.subscription.update({
    where: { id: subscriptionId },
    data: { status: "APPROVED" },
  });
  const payment = await prisma.payment.findFirstOrThrow({
    where: { appointmentId },
    select: { id: true },
  });
  const delivered = new Date(periodStart.getTime() + DAY_MS);
  const upcoming = new Date(Date.now() + 5 * DAY_MS);
  await prisma.appointmentOccurrence.createMany({
    data: [
      {
        appointmentId,
        ordinal: 1,
        startsAt: delivered,
        endsAt: new Date(delivered.getTime() + HOUR_MS),
        isTentative: false,
        consultantProfileId: host.consultantProfileId,
        completionStatus: "COMPLETED",
        completedAt: delivered,
      },
      {
        appointmentId,
        ordinal: 2,
        startsAt: upcoming,
        endsAt: new Date(upcoming.getTime() + HOUR_MS),
        isTentative: false,
        consultantProfileId: host.consultantProfileId,
        completionStatus: "SCHEDULED",
      },
    ],
  });
  for (const cycleOrdinal of [0, 1]) {
    await prisma.consultantEarnings.create({
      data: {
        consultantProfileId: host.consultantProfileId,
        paymentId: payment.id,
        grossAmount: BigInt(200_000),
        platformFeePaise: BigInt(40_000),
        consultantSharePaise: BigInt(140_000),
        cycleOrdinal,
        status: "PENDING",
        holdUntil: null,
      },
    });
  }
  const org = await prisma.organization.create({
    data: { name: "Host org", slug: `db-tier-${randomUUID()}` },
  });
  const orgEarning = await prisma.organizationEarnings.create({
    data: {
      organizationId: org.id,
      paymentId: payment.id,
      grossAmountPaise: BigInt(400_000),
      platformFeePaise: BigInt(80_000),
      orgSharePaise: BigInt(40_000),
      consultantSharePaise: BigInt(280_000),
      status: "PENDING",
      holdUntil: new Date(Date.now() - HOUR_MS),
    },
  });
  return { appointmentId, paymentId: payment.id, orgEarningId: orgEarning.id };
}

const tranches = (paymentId: string) =>
  prisma.consultantEarnings.findMany({
    where: { paymentId },
    orderBy: { cycleOrdinal: "asc" },
    select: { id: true, status: true, holdUntil: true },
  });

it("releases the delivered cycle's tranche on its own date while the next cycle is still scheduled", async () => {
  const plan = await seedTwoCyclePlan();
  await prisma.$transaction((tx) =>
    settleSubscriptionCycle(tx, {
      appointmentId: plan.appointmentId,
      now: new Date(),
    }),
  );
  const [first, second] = await tranches(plan.paymentId);
  expect(first.holdUntil).not.toBeNull();
  expect(second.holdUntil).toBeNull();

  // The 168 h subscription hold on the delivered cycle has passed.
  await prisma.consultantEarnings.update({
    where: { id: first.id },
    data: { holdUntil: new Date(Date.now() - HOUR_MS) },
  });

  // An owed refund on the payment still holds the dated tranche.
  const owed = {
    refundOwedKey: `dbtier-owed:${plan.paymentId}`,
    refundOwedPaise: BigInt(5_000),
    refundOwedReason: "database tier",
    refundOwedAt: new Date(),
  };
  await prisma.payment.update({ where: { id: plan.paymentId }, data: owed });
  await releaseEarningsFromHold();
  expect((await tranches(plan.paymentId)).map((t) => t.status)).toEqual([
    "PENDING",
    "PENDING",
  ]);

  await prisma.payment.update({
    where: { id: plan.paymentId },
    data: {
      refundOwedKey: null,
      refundOwedPaise: null,
      refundOwedReason: null,
      refundOwedAt: null,
    },
  });
  await releaseEarningsFromHold();

  expect((await tranches(plan.paymentId)).map((t) => t.status)).toEqual([
    "READY",
    "PENDING",
  ]);
  expect(
    await prisma.organizationEarnings.findUniqueOrThrow({
      where: { id: plan.orgEarningId },
      select: { status: true },
    }),
  ).toEqual({ status: "PENDING" });
});
