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

type Seeded = Awaited<ReturnType<typeof seedTrialledPlan>>;

/** Starts the plan's checkout and returns the buyer's payment row. */
async function startCheckout({ buyer, plan }: Seeded) {
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
  return prisma.payment.findFirstOrThrow({
    where: { userId: buyer.userId },
    select: {
      id: true,
      appointmentId: true,
      appointment: { select: { subscriptionId: true } },
    },
  });
}

/** The capture's confirmation, as the webhook runs it. */
const confirmCapture = (appointmentId: string, userId: string) =>
  prisma.$transaction(
    (tx) => confirmExistingAppointment(tx, appointmentId, userId),
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );

it("checkout start leaves the trial COMPLETED; the capture converts it", async () => {
  const seeded = await seedTrialledPlan();
  const payment = await startCheckout(seeded);

  // Abandoned here, the trial is still a plain completed trial.
  expect(await trialOf(seeded.trial.id)).toEqual({
    status: "COMPLETED",
    convertedToSubscriptionId: null,
  });

  await confirmCapture(payment.appointmentId!, seeded.buyer.userId);
  expect(await trialOf(seeded.trial.id)).toEqual({
    status: "CONVERTED",
    convertedToSubscriptionId: payment.appointment!.subscriptionId,
  });
});

it("a plan paid more than 30 days after the trial ended is not its conversion", async () => {
  const seeded = await seedTrialledPlan(31);
  const payment = await startCheckout(seeded);
  await confirmCapture(payment.appointmentId!, seeded.buyer.userId);
  expect(await trialOf(seeded.trial.id)).toEqual({
    status: "COMPLETED",
    convertedToSubscriptionId: null,
  });
});

it("is judged at the capture, not when a late reconcile confirms it", async () => {
  // Captured 29 days after the trial ended, confirmed by a sweep on day 31.
  const seeded = await seedTrialledPlan(31);
  const payment = await startCheckout(seeded);
  await prisma.payment.update({
    where: { id: payment.id },
    data: {
      paymentStatus: "SUCCEEDED",
      capturedAt: new Date(Date.now() - 2 * 24 * 3_600_000),
    },
  });
  await confirmCapture(payment.appointmentId!, seeded.buyer.userId);
  expect((await trialOf(seeded.trial.id)).status).toBe("CONVERTED");
});
