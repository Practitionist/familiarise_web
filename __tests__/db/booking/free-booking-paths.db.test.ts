/**
 * The two free booking writes end to end on real Postgres: a free webinar
 * seat confirms on the no-gateway rail with no tax invoice, and a free trial
 * request commits its trial with both bells and both emails staged. Run with
 * `scripts/dev/db-tier-local.sh --log-statements` to count their statements.
 */
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import prisma from "../../../lib/prisma";
import { toPlain } from "../../../lib/data/serialize";
import { EARNINGS_PAYMENT_INCLUDE } from "../../../lib/payments/payouts/earnings-service";
import { futureAt, seedHost } from "./harness";
import { publishEveryHour, seedBuyer } from "./harness-host";
import {
  seatCheckoutInput,
  seedHeldSeat,
  seedSeatBuyer,
  seedWebinar,
} from "./harness-seats";
import { sessionUser } from "./harness-edges";

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
jest.mock("../../../lib/auth-helpers", () =>
  jest.requireActual("./harness-edges").authHelpersMock(),
);
jest.mock("../../../lib/rate-limit", () => ({
  ...jest.requireActual("./harness-edges").rateLimitMock(),
  trialRequestRefusal: async () => null,
  spendTrialRequest: async () => undefined,
}));
jest.mock("../../../lib/novu/stage-then-attempt", () =>
  jest.requireActual("./harness-edges").noFlushMock(),
);
// React Email's renderer needs ESM dynamic import, which jest lacks; rendering issues no statement.
jest.mock("../../../lib/email/render", () => ({
  __esModule: true,
  renderEmail: async () => ({ html: "<p>rendered</p>", text: "rendered" }),
}));
// Chat channels are made after the response; they are not on the counted path.
jest.mock("../../../lib/payments/webhooks/ensure-channels", () => ({
  __esModule: true,
  ensureChannelsForAppointment: jest.fn(async () => undefined),
}));

import { handleCheckout } from "../../../lib/payments/checkout";
import { POST as requestTrial } from "../../../app/api/trials/route";

it("a free webinar seat is confirmed on the no-gateway rail with no invoice", async () => {
  const webinar = await seedWebinar({ capacity: 20, price: 0 });
  const buyer = await seedSeatBuyer();

  await handleCheckout(
    seatCheckoutInput(webinar, `free-seat-${randomUUID()}`),
    buyer.userId,
  );

  const payment = await prisma.payment.findFirstOrThrow({
    where: { userId: buyer.userId },
    select: { id: true, paymentStatus: true, amount: true },
  });
  expect(payment.paymentStatus).toBe("SUCCEEDED");
  expect(Number(payment.amount)).toBe(0);
  const seat = await prisma.appointmentParticipant.findFirstOrThrow({
    where: { appointmentId: webinar.appointmentId, userId: buyer.userId },
    select: { status: true, paymentId: true },
  });
  expect(seat).toEqual({ status: "CONFIRMED", paymentId: payment.id });
  expect(
    await prisma.consumerInvoice.count({ where: { paymentId: payment.id } }),
  ).toBe(0);
  // No capture follows a free seat, so checkout stages its booked bell itself.
  const booked = await prisma.notificationOutbox.findMany({
    where: {
      workflowId: "appointment-booked",
      recipients: { has: buyer.userId },
    },
    select: { id: true },
  });
  expect(booked).toHaveLength(1);

  // The joined earnings read returns what the per-relation read does, Decimal included.
  await prisma.payment.update({
    where: { id: payment.id },
    data: { exchangeRateAtCheckout: "0.012345" },
  });
  const earningsRead = (relationLoadStrategy: "join" | "query") =>
    prisma.payment.findUniqueOrThrow({
      where: { id: payment.id },
      include: EARNINGS_PAYMENT_INCLUDE,
      relationLoadStrategy,
    });
  const joined = toPlain(await earningsRead("join"));
  expect(joined).toEqual(toPlain(await earningsRead("query")));
  expect(joined.appointment?.webinar?.webinarPlan.consultantProfile?.id).toBe(
    webinar.host.consultantProfileId,
  );
});

it("a free checkout takes over the HELD seat a lapsed card order left, and records the registration", async () => {
  const webinar = await seedWebinar({ capacity: 20, price: 50_000 });
  // The card attempt lapsed while the event cost ₹500; no sweep has released its seat yet.
  const { buyer, payment } = await seedHeldSeat(webinar, {
    status: "EXPIRED",
    expiresAt: new Date(Date.now() - 60_000),
  });
  await prisma.webinarPlan.update({
    where: { id: webinar.planId },
    data: { price: BigInt(0) },
  });

  await handleCheckout(
    seatCheckoutInput(webinar, `stale-hold-${randomUUID()}`),
    buyer.userId,
  );

  const seat = await prisma.appointmentParticipant.findFirstOrThrow({
    where: { appointmentId: webinar.appointmentId, userId: buyer.userId },
    select: { id: true, status: true, paymentId: true },
  });
  expect(seat).toMatchObject({ status: "CONFIRMED", paymentId: payment.id });
  expect(
    await prisma.payment.findUniqueOrThrow({
      where: { id: payment.id },
      select: { paymentStatus: true },
    }),
  ).toEqual({ paymentStatus: "SUCCEEDED" });
  const history = await prisma.bookingStatusHistory.findMany({
    where: { entity: "SEAT", entityId: seat.id },
    select: { reason: true, fromStatus: true, toStatus: true },
  });
  expect(history).toEqual([
    { reason: "registered", fromStatus: "HELD", toStatus: "CONFIRMED" },
  ]);
});

it("a moved webinar sells against its live session, not the replaced one", async () => {
  const webinar = await seedWebinar({ capacity: 20, price: 0 });
  // The original time moved: its row is a past RESCHEDULED tombstone, read first.
  await prisma.appointmentOccurrence.updateMany({
    where: { appointmentId: webinar.appointmentId },
    data: {
      completionStatus: "RESCHEDULED",
      startsAt: new Date(Date.now() - 3 * 3_600_000),
      endsAt: new Date(Date.now() - 2 * 3_600_000),
    },
  });
  await prisma.appointmentOccurrence.create({
    data: {
      appointmentId: webinar.appointmentId,
      ordinal: 2,
      startsAt: webinar.startsAt,
      endsAt: webinar.endsAt,
      isTentative: false,
      consultantProfileId: webinar.host.consultantProfileId,
    },
  });
  const buyer = await seedSeatBuyer();

  await handleCheckout(
    seatCheckoutInput(webinar, `moved-seat-${randomUUID()}`),
    buyer.userId,
  );

  const seat = await prisma.appointmentParticipant.findFirstOrThrow({
    where: { appointmentId: webinar.appointmentId, userId: buyer.userId },
    select: { status: true },
  });
  expect(seat.status).toBe("CONFIRMED");
});

it("a free trial request commits its trial with both bells and both emails", async () => {
  const host = await seedHost();
  await publishEveryHour(host);
  const plan = await prisma.subscriptionPlan.create({
    data: {
      title: "Free trial plan",
      price: BigInt(400_000),
      consultantProfileId: host.consultantProfileId,
      sessionsPerWeek: 1,
      durationInMonths: 1,
      sessionDurationInHours: 1,
      totalSessions: 4,
      trialEnabled: true,
      trialDurationMinutes: 30,
      trialPriceInPaise: BigInt(0),
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
  const startsAt = futureAt(3, 10);

  const res = await requestTrial(
    new NextRequest("http://localhost/api/trials", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        consulteeProfileId: buyer.consulteeProfileId,
        consultantProfileId: host.consultantProfileId,
        subscriptionPlanId: plan.id,
        slot: {
          startsAt: startsAt.toISOString(),
          endsAt: new Date(startsAt.getTime() + 30 * 60_000).toISOString(),
        },
      }),
    }),
  );

  expect(res.status).toBe(201);
  const { data } = (await res.json()) as { data: { id: string } };
  const trial = await prisma.trial.findUniqueOrThrow({
    where: { id: data.id },
    select: { status: true },
  });
  expect(trial.status).toBe("SCHEDULED");
  const bells = await prisma.notificationOutbox.findMany({
    where: {
      workflowId: "trial-session-scheduled",
      recipients: { hasSome: [buyer.userId, host.userId] },
    },
    select: { recipients: true, kind: true },
  });
  expect(bells.map((b) => b.recipients).sort()).toEqual(
    [[buyer.userId], [host.userId]].sort(),
  );
  expect(bells.every((b) => b.kind === "SINGLE")).toBe(true);
  expect(
    await prisma.failedEmail.count({
      where: { entityRef: `trial:${data.id}` },
    }),
  ).toBe(2);
});
