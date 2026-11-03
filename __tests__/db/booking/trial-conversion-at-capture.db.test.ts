/**
 * A completed trial converts only when the subscription is paid: checkout
 * start leaves it COMPLETED (so an abandoned checkout never counts as a
 * conversion), and the capture links it, once.
 */
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import prisma from "../../../lib/prisma";
import { futureAt, seedHost } from "./harness";
import { publishEveryHour, seedBuyer } from "./harness-host";

jest.mock("../../../lib/payments/index", () => ({
  __esModule: true,
  createPaymentIntent: jest.fn(async () => ({
    id: `order_${randomUUID()}`,
    client_secret: null,
  })),
  cancelPaymentIntent: jest.fn(async () => undefined),
}));
jest.mock("../../../lib/compliance/dpdp", () => ({
  __esModule: true,
  checkConsent: jest.fn(async () => true),
}));
jest.mock("../../../lib/novu", () => {
  const noop = jest.fn(async () => []);
  return new Proxy(
    {},
    { get: (_target, prop) => (prop === "__esModule" ? true : noop) },
  );
});

import { handleCheckout } from "../../../lib/payments/checkout";
import { confirmExistingAppointment } from "../../../lib/payments/webhooks/handlers";

async function seedTrialledPlan(completedDaysAgo = 1) {
  const host = await seedHost();
  await publishEveryHour(host);
  const buyer = await seedBuyer();
  const plan = await prisma.subscriptionPlan.create({
    data: {
      title: "Trial conversion plan",
      price: BigInt(400_000),
      consultantProfileId: host.consultantProfileId,
      sessionsPerWeek: 1,
      durationInMonths: 1,
      sessionDurationInHours: 1,
      totalSessions: 4,
    },
  });
  const trial = await prisma.trial.create({
    data: {
      consulteeProfileId: buyer.consulteeProfileId,
      consultantProfileId: host.consultantProfileId,
      subscriptionPlanId: plan.id,
      status: "COMPLETED",
      completedAt: new Date(Date.now() - completedDaysAgo * 24 * 3_600_000),
    },
  });
  return { host, buyer, plan, trial };
}

const trialOf = (id: string) =>
  prisma.trial.findUniqueOrThrow({
    where: { id },
    select: { status: true, convertedToSubscriptionId: true },
  });

it("checkout start leaves the trial COMPLETED; the capture converts it", async () => {
  const { buyer, plan, trial } = await seedTrialledPlan();

  await handleCheckout(
    {
      appointmentType: "SUBSCRIPTION",
      planId: plan.id,
      schedulingPeriodStartsAt: futureAt(2, 0).toISOString(),
      paymentGateway: "RAZORPAY",
      clientIdempotencyKey: `trial-conv-${randomUUID()}`,
      consumerStateCode: "29",
    },
    buyer.userId,
  );

  // Abandoned here, the trial is still a plain completed trial.
  expect(await trialOf(trial.id)).toEqual({
    status: "COMPLETED",
    convertedToSubscriptionId: null,
  });

  const payment = await prisma.payment.findFirstOrThrow({
    where: { userId: buyer.userId },
    select: {
      appointmentId: true,
      appointment: { select: { subscriptionId: true } },
    },
  });
  await prisma.$transaction(
    (tx) =>
      confirmExistingAppointment(tx, payment.appointmentId!, buyer.userId),
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );

  expect(await trialOf(trial.id)).toEqual({
    status: "CONVERTED",
    convertedToSubscriptionId: payment.appointment!.subscriptionId,
  });
});

it("a plan paid more than 30 days after the trial ended is not its conversion", async () => {
  const { buyer, plan, trial } = await seedTrialledPlan(31);
  await handleCheckout(
    {
      appointmentType: "SUBSCRIPTION",
      planId: plan.id,
      schedulingPeriodStartsAt: futureAt(2, 0).toISOString(),
      paymentGateway: "RAZORPAY",
      clientIdempotencyKey: `trial-conv-late-${randomUUID()}`,
      consumerStateCode: "29",
    },
    buyer.userId,
  );
  const payment = await prisma.payment.findFirstOrThrow({
    where: { userId: buyer.userId },
    select: { appointmentId: true },
  });
  await prisma.$transaction(
    (tx) =>
      confirmExistingAppointment(tx, payment.appointmentId!, buyer.userId),
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
  expect(await trialOf(trial.id)).toEqual({
    status: "COMPLETED",
    convertedToSubscriptionId: null,
  });
});
