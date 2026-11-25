/**
 * A moderation ban on real Postgres: a plan refunds only its undelivered
 * sessions, whoever was banned; a live plan with nothing placed ahead is ended
 * too; sessions support already refunded are not paid twice; and a
 * single-session consultation not yet held still refunds in full.
 */
import "./harness-cancel-route";
import { randomUUID } from "node:crypto";
import prisma from "../../../lib/prisma";
import {
  futureAt,
  HOUR_MS,
  seedConsultee,
  seedHost,
  seedOneToOne,
} from "./harness";
import { seedCardPayment } from "./harness-plans";
import { refundedPaise, refundOnRowsEachTest } from "./harness-refunds";

import { cancelFutureEngagementsForUser } from "../../../lib/moderation/cancel-user-engagements";

const DAY_MS = 24 * HOUR_MS;
/** ₹36,000 for 24 sessions at 2 a week: ₹1,500 a session, 12 tranches of ₹2,400 share. */
const PRICE = 3_600_000;
const SESSIONS = 24;
const UNIT = PRICE / SESSIONS;

refundOnRowsEachTest();

/** A live plan with `delivered` sessions held on separate past days and `placedAhead` on separate future days. */
async function seedPlan(shape: {
  delivered: number;
  placedAhead: number;
  sessionsRefunded?: number;
}) {
  const host = await seedHost();
  const buyer = await seedConsultee();
  const now = Date.now();
  const plan = await prisma.subscriptionPlan.create({
    data: {
      title: "Twelve weeks",
      price: BigInt(PRICE),
      totalSessions: SESSIONS,
      sessionsPerWeek: 2,
      durationInMonths: 3,
      consultantProfileId: host.consultantProfileId,
    },
  });
  const subscription = await prisma.subscription.create({
    data: {
      subscriptionPlanId: plan.id,
      requestedById: buyer.consulteeProfileId,
      status: "APPROVED",
      bookingSource: "DIRECT_CHECKOUT",
      sessionsTotal: SESSIONS,
      sessionsPerWeek: 2,
      sessionMinutes: 60,
      sessionsRefunded: shape.sessionsRefunded ?? 0,
      schedulingPeriodStartsAt: new Date(now - 30 * DAY_MS),
      schedulingPeriodEndsAt: new Date(now - 23 * DAY_MS),
      planEndsAt: new Date(now + 54 * DAY_MS),
      schedulingTimezone: "UTC",
    },
  });
  const appointment = await prisma.appointment.create({
    data: { appointmentType: "SUBSCRIPTION", subscriptionId: subscription.id },
  });
  for (let i = 0; i < shape.delivered + shape.placedAhead; i += 1) {
    const held = i < shape.delivered;
    // One session a day, so no two confirmed sessions of the host overlap.
    const startsAt = held
      ? new Date(now - (shape.delivered - i + 1) * DAY_MS)
      : new Date(now + (i - shape.delivered + 2) * DAY_MS);
    await prisma.appointmentOccurrence.create({
      data: {
        appointmentId: appointment.id,
        ordinal: i + 1,
        startsAt,
        endsAt: new Date(startsAt.getTime() + HOUR_MS),
        isTentative: false,
        consultantProfileId: host.consultantProfileId,
        completionStatus: held ? "COMPLETED" : "SCHEDULED",
        ...(held ? { completedAt: startsAt } : {}),
      },
    });
  }
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
        userId: buyer.userId,
        role: "CONSULTEE",
        status: "CONFIRMED",
      },
    ],
  });
  const payment = await seedCardPayment(buyer.userId, appointment.id, PRICE);
  const deliveredTranches = Math.floor(shape.delivered / 2);
  for (let cycleOrdinal = 0; cycleOrdinal < 12; cycleOrdinal += 1) {
    await prisma.consultantEarnings.create({
      data: {
        consultantProfileId: host.consultantProfileId,
        paymentId: payment.id,
        grossAmount: BigInt(PRICE / 12),
        platformFeePaise: BigInt(60_000),
        consultantSharePaise: BigInt(240_000),
        cycleOrdinal,
        status: "PENDING",
        holdUntil:
          cycleOrdinal < deliveredTranches ? new Date(now + 7 * DAY_MS) : null,
      },
    });
  }
  if (shape.sessionsRefunded) {
    // The support refund that took those sessions off the plan, already cascaded.
    await prisma.refund.create({
      data: {
        paymentId: payment.id,
        amountPaise: BigInt(shape.sessionsRefunded * UNIT),
        status: "SUCCEEDED",
        refundId: `rfnd_dbtier_${randomUUID()}`,
        paymentGateway: "RAZORPAY",
        cascadedAt: new Date(),
      },
    });
  }
  return {
    host,
    buyer,
    subscriptionId: subscription.id,
    appointmentId: appointment.id,
    paymentId: payment.id,
  };
}

const ban = async (userId: string) => {
  const admin = await seedHost();
  return cancelFutureEngagementsForUser(userId, {
    initiatedByUserId: admin.userId,
  });
};

async function expectPlanEnded(plan: {
  subscriptionId: string;
  appointmentId: string;
  paymentId: string;
}) {
  const sub = await prisma.subscription.findUniqueOrThrow({
    where: { id: plan.subscriptionId },
    select: { status: true, cancellationReason: true },
  });
  expect(sub).toEqual({
    status: "CANCELLED",
    cancellationReason: "MODERATION",
  });
  // Nothing of the plan still holds the expert's time; the delivered sessions stand.
  expect(
    await prisma.appointmentOccurrence.count({
      where: {
        appointmentId: plan.appointmentId,
        completionStatus: "SCHEDULED",
        deletedAt: null,
      },
    }),
  ).toBe(0);
  const payment = await prisma.payment.findUniqueOrThrow({
    where: { id: plan.paymentId },
    select: { refundOwedKey: true },
  });
  expect(payment.refundOwedKey).toBeNull();
  // Every tranche the refund left has its hold started, so none is stranded.
  expect(
    await prisma.consultantEarnings.count({
      where: { paymentId: plan.paymentId, holdUntil: null },
    }),
  ).toBe(0);
}

describe("a ban refunds a plan for what was not delivered", () => {
  it("expert banned with 8 of 24 delivered: ₹24,000 back under the ban's own key", async () => {
    const plan = await seedPlan({ delivered: 8, placedAhead: 2 });

    const summary = await ban(plan.host.userId);

    expect(summary.failures).toEqual([]);
    expect(summary.engagementsCancelled).toBe(1);
    expect(await refundedPaise(plan.paymentId)).toBe(16 * UNIT);
    const refunds = await prisma.refund.findMany({
      where: { paymentId: plan.paymentId },
      select: { dedupeKey: true, amountPaise: true },
    });
    expect(refunds).toEqual([
      {
        dedupeKey: `moderation:${plan.appointmentId}:${plan.paymentId}`,
        amountPaise: 16 * UNIT,
      },
    ]);
    await expectPlanEnded(plan);
    expect(
      await prisma.appointmentOccurrence.count({
        where: {
          appointmentId: plan.appointmentId,
          completionStatus: "COMPLETED",
        },
      }),
    ).toBe(8);
  });

  it("learner banned, same plan: the same ₹24,000", async () => {
    const plan = await seedPlan({ delivered: 8, placedAhead: 2 });

    const summary = await ban(plan.buyer.userId);

    expect(summary.failures).toEqual([]);
    expect(await refundedPaise(plan.paymentId)).toBe(16 * UNIT);
    await expectPlanEnded(plan);
  });

  it("a live plan with nothing placed ahead is ended and refunded too", async () => {
    const plan = await seedPlan({ delivered: 8, placedAhead: 0 });

    const summary = await ban(plan.host.userId);

    expect(summary.engagementsCancelled).toBe(1);
    expect(await refundedPaise(plan.paymentId)).toBe(16 * UNIT);
    await expectPlanEnded(plan);
  });

  it("2 sessions support already refunded are not paid twice: ₹21,000 more, ₹24,000 in all", async () => {
    const plan = await seedPlan({
      delivered: 8,
      placedAhead: 2,
      sessionsRefunded: 2,
    });

    await ban(plan.host.userId);

    expect(await refundedPaise(plan.paymentId)).toBe(2 * UNIT + 14 * UNIT);
    await expectPlanEnded(plan);
  });

  it("a plan with every session held and none owed is left to the plan end", async () => {
    const plan = await seedPlan({ delivered: SESSIONS, placedAhead: 0 });

    const summary = await ban(plan.host.userId);

    expect(summary.engagementsCancelled).toBe(0);
    expect(await refundedPaise(plan.paymentId)).toBe(0);
    const sub = await prisma.subscription.findUniqueOrThrow({
      where: { id: plan.subscriptionId },
      select: { status: true },
    });
    expect(sub.status).toBe("APPROVED");
  });
});

describe("a ban on a single-session consultation", () => {
  it("not yet held: refunds in full", async () => {
    const host = await seedHost();
    const buyer = await seedConsultee();
    const startsAt = futureAt(3, 9);
    const booking = await seedOneToOne(
      "consultation",
      host,
      buyer,
      { startsAt, endsAt: new Date(startsAt.getTime() + HOUR_MS) },
      {
        status: "APPROVED",
        isTentative: false,
        payment: { status: "SUCCEEDED", expiresAt: null, amount: UNIT },
      },
    );

    const summary = await ban(host.userId);

    expect(summary.engagementsCancelled).toBe(1);
    expect(await refundedPaise(booking.payment!.id)).toBe(UNIT);
    const row = await prisma.consultation.findUniqueOrThrow({
      where: { id: booking.consultationId! },
      select: { status: true },
    });
    expect(row.status).toBe("CANCELLED");
  });
});
