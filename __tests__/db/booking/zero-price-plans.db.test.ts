/**
 * A plan priced at ₹0 can be bought: the order takes the no-gateway rail, the
 * booking is confirmed at birth, and because no money moves there is no
 * booking journal, no tax invoice and no reconciler finding.
 */
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import prisma from "../../../lib/prisma";
import { futureAt, seedHost } from "./harness";
import {
  consultationCheckout,
  publishEveryHour,
  seedBuyer,
} from "./harness-host";
import { seedClassUnderWay } from "./harness-class-series";

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
const sessionUser = { current: null as null | Record<string, unknown> };
jest.mock("../../../lib/auth-helpers", () => ({
  ...jest.requireActual("../../../lib/auth-helpers"),
  requireApiAuth: async () => ({ session: { user: sessionUser.current } }),
  isPrivileged: () => false,
}));
jest.mock("../../../lib/rate-limit", () => ({
  ...jest.requireActual("../../../lib/rate-limit"),
  applyRateLimit: async () => null,
}));
jest.mock("../../../lib/cron/with-cron-lock", () => ({
  ...jest.requireActual("../../../lib/cron/with-cron-lock"),
  withCronLock: (_job: string, _opts: unknown, run: () => Promise<unknown>) =>
    run(),
}));
jest.mock("../../../lib/observability/report", () => {
  const actual = jest.requireActual("../../../lib/observability/report");
  return {
    ...actual,
    reportSentryError: jest.fn(actual.reportSentryError),
  };
});

import { handleCheckout } from "../../../lib/payments/checkout";
import { POST as checkout } from "../../../app/api/checkout/route";
import { reportSentryError } from "../../../lib/observability/report";
import { runReconcileLedgers } from "../../../scripts/reconcile/reconcile-ledgers";

const reported = jest.mocked(reportSentryError);

const OLD_GSTIN = process.env.PLATFORM_GSTIN;
// A configured supplier, so "no invoice" means the ₹0 guard and not a missing GSTIN.
beforeAll(() => {
  process.env.PLATFORM_GSTIN = "06AAFCF1234Q1ZN";
});
afterAll(() => {
  if (OLD_GSTIN === undefined) delete process.env.PLATFORM_GSTIN;
  else process.env.PLATFORM_GSTIN = OLD_GSTIN;
});
beforeEach(() => jest.clearAllMocks());

/** Conversion is about the expert relationship, so a ₹0 plan after a trial still converts it. */
const TRIAL_AFTER_FREE_PURCHASE = (subscriptionId: string | null) => ({
  status: "CONVERTED",
  convertedToSubscriptionId: subscriptionId,
});

/** The buyer's one payment, after asserting it settled at ₹0 with nothing journalled or invoiced. */
async function expectFreeSettledPayment(userId: string) {
  const gateway = jest.requireMock("../../../lib/payments/index") as {
    createPaymentIntent: jest.Mock;
  };
  expect(gateway.createPaymentIntent).not.toHaveBeenCalled();
  const payment = await prisma.payment.findFirstOrThrow({ where: { userId } });
  expect(payment.paymentStatus).toBe("SUCCEEDED");
  expect(Number(payment.amount)).toBe(0);
  expect(payment.appointmentId).not.toBeNull();
  expect(
    await prisma.ledgerTransaction.count({ where: { paymentId: payment.id } }),
  ).toBe(0);
  expect(
    await prisma.consumerInvoice.count({ where: { paymentId: payment.id } }),
  ).toBe(0);
  const earnings = await prisma.consultantEarnings.findMany({
    where: { paymentId: payment.id },
  });
  for (const row of earnings) {
    expect(Number(row.grossAmount)).toBe(0);
    expect(Number(row.platformFeePaise)).toBe(0);
    expect(Number(row.consultantSharePaise)).toBe(0);
  }
  expect(reported).not.toHaveBeenCalled();
  return payment;
}

it("a ₹0 subscription is bought end to end through the checkout route", async () => {
  const host = await seedHost();
  await publishEveryHour(host);
  const plan = await prisma.subscriptionPlan.create({
    data: {
      title: "Free subscription",
      price: BigInt(0),
      consultantProfileId: host.consultantProfileId,
    },
  });
  const buyer = await seedBuyer();
  sessionUser.current = {
    id: buyer.userId,
    role: "CONSULTEE",
    consulteeProfileId: buyer.consulteeProfileId,
    consultantProfileId: null,
    name: "Buyer",
  };

  const res = await checkout(
    new NextRequest("http://localhost/api/checkout", {
      method: "POST",
      body: JSON.stringify({
        appointmentType: "SUBSCRIPTION",
        planId: plan.id,
        schedulingPeriodStartsAt: futureAt(1, 0).toISOString(),
        paymentGateway: "RAZORPAY",
        clientIdempotencyKey: `free-sub-${randomUUID()}`,
        consumerStateCode: "29",
      }),
      headers: { "Content-Type": "application/json" },
    }),
  );

  expect(res.status).toBe(200);
  const payment = await expectFreeSettledPayment(buyer.userId);
  const appointment = await prisma.appointment.findUniqueOrThrow({
    where: { id: payment.appointmentId! },
    select: { subscriptionId: true },
  });
  expect(appointment.subscriptionId).not.toBeNull();
  const subscription = await prisma.subscription.findUniqueOrThrow({
    where: { id: appointment.subscriptionId! },
  });
  expect(subscription.subscriptionPlanId).toBe(plan.id);

  // A fresh scope, so the run audits now instead of reusing today's verdict.
  const audit = await runReconcileLedgers({
    scope: `zero-price-${randomUUID()}`,
  });
  expect(audit.reused).toBeUndefined();
  expect(audit.findings.filter((f) => f.paymentId === payment.id)).toEqual([]);
});

it("a ₹0 consultation books on the no-gateway rail", async () => {
  const host = await seedHost();
  await publishEveryHour(host);
  const plan = await prisma.consultationPlan.create({
    data: {
      title: "Free consultation",
      price: BigInt(0),
      consultantProfileId: host.consultantProfileId,
      durationInHours: 1,
    },
  });
  const buyer = await seedBuyer();

  await handleCheckout(
    consultationCheckout(plan.id, futureAt(6, 10), `free-cons-${randomUUID()}`),
    buyer.userId,
  );

  const payment = await expectFreeSettledPayment(buyer.userId);
  const appointment = await prisma.appointment.findUniqueOrThrow({
    where: { id: payment.appointmentId! },
    select: { consultation: { select: { consultationPlanId: true } } },
  });
  expect(appointment.consultation?.consultationPlanId).toBe(plan.id);
});

it("a ₹0 class seat is bought on the no-gateway rail", async () => {
  const host = await seedHost();
  await prisma.consultantProfile.update({
    where: { id: host.consultantProfileId },
    data: { verificationStatus: "VERIFIED" },
  });
  const cls = await seedClassUnderWay(host, {
    price: 0,
    sessions: 2,
    delivered: 0,
  });
  const { classPlanId } = await prisma.class.findUniqueOrThrow({
    where: { id: cls.classId },
    select: { classPlanId: true },
  });
  const buyer = await seedBuyer();

  await handleCheckout(
    {
      appointmentType: "CLASS",
      planId: classPlanId,
      eventId: cls.classId,
      paymentGateway: "RAZORPAY",
      clientIdempotencyKey: `free-class-${randomUUID()}`,
      consumerStateCode: "29",
    },
    buyer.userId,
  );

  const payment = await expectFreeSettledPayment(buyer.userId);
  expect(payment.appointmentId).toBe(cls.appointmentId);
  const seat = await prisma.appointmentParticipant.findFirstOrThrow({
    where: { appointmentId: cls.appointmentId, userId: buyer.userId },
  });
  expect(seat.paymentId).toBe(payment.id);
});

it("a completed trial bought at ₹0 is confirmed without a fault", async () => {
  const host = await seedHost();
  await publishEveryHour(host);
  const buyer = await seedBuyer();
  const plan = await prisma.subscriptionPlan.create({
    data: {
      title: "Free plan after a trial",
      price: BigInt(0),
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
      completedAt: new Date(Date.now() - 24 * 3_600_000),
    },
  });

  await handleCheckout(
    {
      appointmentType: "SUBSCRIPTION",
      planId: plan.id,
      schedulingPeriodStartsAt: futureAt(2, 0).toISOString(),
      paymentGateway: "RAZORPAY",
      clientIdempotencyKey: `free-trial-${randomUUID()}`,
      consumerStateCode: "29",
    },
    buyer.userId,
  );

  const payment = await expectFreeSettledPayment(buyer.userId);
  const { subscriptionId } = await prisma.appointment.findUniqueOrThrow({
    where: { id: payment.appointmentId! },
    select: { subscriptionId: true },
  });
  expect(
    await prisma.trial.findUniqueOrThrow({
      where: { id: trial.id },
      select: { status: true, convertedToSubscriptionId: true },
    }),
  ).toEqual(TRIAL_AFTER_FREE_PURCHASE(subscriptionId));
});

it("a charged payment whose earnings carry no gross still needs its journal", async () => {
  const host = await seedHost();
  const buyer = await seedBuyer();
  const payment = await prisma.payment.create({
    data: {
      amount: BigInt(9_000),
      originalAmount: BigInt(0),
      paymentMethod: "card",
      paymentIntent: `order_dbtier_${randomUUID()}`,
      paymentGateway: "RAZORPAY",
      paymentStatus: "SUCCEEDED",
      userId: buyer.userId,
      isMockPayment: true,
      legs: { create: [{ source: "CARD", amountPaise: BigInt(9_000) }] },
    },
  });
  await prisma.consultantEarnings.create({
    data: {
      consultantProfileId: host.consultantProfileId,
      paymentId: payment.id,
      grossAmount: BigInt(0),
      platformFeePaise: BigInt(0),
      consultantSharePaise: BigInt(0),
    },
  });

  const audit = await runReconcileLedgers({
    scope: `zero-price-${randomUUID()}`,
  });
  expect(
    audit.findings.filter((f) => f.paymentId === payment.id).map((f) => f.kind),
  ).toEqual(["EARNINGS_WITHOUT_BOOKING_TXN"]);
});
