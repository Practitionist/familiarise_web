/**
 * An ended plan whose refund is owed keeps its host's earnings held, on real
 * Postgres: the plan-end settlement stamps the tranche holds and the owed
 * marker in one commit, the gateway keeps failing, and once the holds have run
 * out neither the consultant nor the host-organisation earning is released
 * until the marker clears (a successful re-drive, or support settling it by
 * hand after the drive's attempts are spent).
 */
import { randomUUID } from "node:crypto";
import prisma from "../../../lib/prisma";
import { HOUR_MS, seedConsultee, seedHost } from "./harness";

jest.mock("../../../lib/novu", () => {
  const noop = jest.fn(async () => []);
  return new Proxy(
    {},
    { get: (_target, prop) => (prop === "__esModule" ? true : noop) },
  );
});
jest.mock("../../../lib/novu/service", () => {
  const noop = jest.fn(async () => []);
  return new Proxy(
    {},
    { get: (_target, prop) => (prop === "__esModule" ? true : noop) },
  );
});
jest.mock("../../../lib/novu/stage-then-attempt", () => ({
  __esModule: true,
  flushNotificationsAfter: jest.fn(async () => undefined),
}));

import { RefundGatewayError } from "../../../lib/payments/operations/refund";
import {
  driveRefundOwed,
  markerFromRow,
  MAX_REFUND_OWED_ATTEMPTS,
  REFUND_OWED_SELECT,
  settleOwedByHand,
} from "../../../lib/payments/operations/refund-owed";
import {
  planEndRefundKey,
  settleCancelledSessions,
} from "../../../scripts/appointments/settle-cancelled-sessions";
import { releaseEarningsFromHold } from "../../../scripts/earnings/release-earnings";

const refundDoor = jest.requireMock(
  "../../../lib/payments/operations/booking-refund",
) as { refundBookingPayment: jest.Mock };

const DAY_MS = 24 * HOUR_MS;
const PRICE = 100_000;

const gatewayDown = () =>
  new RefundGatewayError("gateway unavailable", "GATEWAY_ERROR", "rf_dbtier");

/**
 * A 4-session plan that ended an hour ago with 3 sessions delivered and 1
 * voided, paid by card, with one unstamped consultant tranche and one
 * unstamped host-organisation earning on its payment.
 */
async function seedEndedPlan() {
  const host = await seedHost();
  const buyer = await seedConsultee();
  const now = Date.now();
  const org = await prisma.organization.create({
    data: { name: "Host org", slug: `db-tier-${randomUUID()}` },
  });
  const plan = await prisma.subscriptionPlan.create({
    data: {
      title: "Weekly mentoring",
      price: BigInt(PRICE),
      totalSessions: 4,
      sessionsPerWeek: 1,
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
      schedulingPeriodStartsAt: new Date(now - 25 * DAY_MS),
      schedulingPeriodEndsAt: new Date(now - 18 * DAY_MS),
      planEndsAt: new Date(now - HOUR_MS),
      schedulingTimezone: "UTC",
    },
  });
  const appointment = await prisma.appointment.create({
    data: { appointmentType: "SUBSCRIPTION", subscriptionId: subscription.id },
  });
  const shapes = ["COMPLETED", "COMPLETED", "VOIDED", "COMPLETED"] as const;
  for (const [i, shape] of shapes.entries()) {
    const startsAt = new Date(now - (shapes.length - i + 1) * DAY_MS);
    await prisma.appointmentOccurrence.create({
      data: {
        appointmentId: appointment.id,
        ordinal: i + 1,
        startsAt,
        endsAt: new Date(startsAt.getTime() + HOUR_MS),
        isTentative: false,
        consultantProfileId: host.consultantProfileId,
        completionStatus: shape,
        ...(shape === "COMPLETED" && { completedAt: startsAt }),
        ...(shape === "VOIDED" && { voidedAt: startsAt }),
      },
    });
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
  const consultantEarning = await prisma.consultantEarnings.create({
    data: {
      consultantProfileId: host.consultantProfileId,
      paymentId: payment.id,
      grossAmount: BigInt(PRICE),
      platformFeePaise: BigInt(20_000),
      consultantSharePaise: BigInt(70_000),
      cycleOrdinal: 0,
      status: "PENDING",
      holdUntil: null,
    },
  });
  const orgEarning = await prisma.organizationEarnings.create({
    data: {
      organizationId: org.id,
      paymentId: payment.id,
      grossAmountPaise: BigInt(PRICE),
      platformFeePaise: BigInt(20_000),
      orgSharePaise: BigInt(10_000),
      consultantSharePaise: BigInt(70_000),
      status: "PENDING",
      holdUntil: null,
    },
  });
  return {
    subscriptionId: subscription.id,
    paymentId: payment.id,
    consultantEarningId: consultantEarning.id,
    orgEarningId: orgEarning.id,
  };
}

type Seeded = Awaited<ReturnType<typeof seedEndedPlan>>;

const statuses = async (s: Seeded) => {
  const [consultant, org] = [
    await prisma.consultantEarnings.findUniqueOrThrow({
      where: { id: s.consultantEarningId },
      select: { status: true, holdUntil: true },
    }),
    await prisma.organizationEarnings.findUniqueOrThrow({
      where: { id: s.orgEarningId },
      select: { status: true, holdUntil: true },
    }),
  ];
  return { consultant, org };
};

/** The plan-end commit with a failing gateway, then the stamped holds run out. */
async function settleWithFailingGatewayAndLetHoldsLapse(s: Seeded) {
  refundDoor.refundBookingPayment.mockRejectedValue(gatewayDown());
  await settleCancelledSessions();

  const payment = await prisma.payment.findUniqueOrThrow({
    where: { id: s.paymentId },
    select: { refundOwedKey: true, refundOwedAttempts: true },
  });
  expect(payment).toEqual({
    refundOwedKey: planEndRefundKey(s.subscriptionId, s.paymentId),
    refundOwedAttempts: 1,
  });
  const stamped = await statuses(s);
  expect(stamped.consultant.holdUntil).not.toBeNull();
  expect(stamped.org.holdUntil).not.toBeNull();

  // The 168 h subscription hold has passed.
  const lapsed = new Date(Date.now() - HOUR_MS);
  await prisma.consultantEarnings.update({
    where: { id: s.consultantEarningId },
    data: { holdUntil: lapsed },
  });
  await prisma.organizationEarnings.update({
    where: { id: s.orgEarningId },
    data: { holdUntil: lapsed },
  });
}

async function redrive(paymentId: string) {
  const row = await prisma.payment.findUniqueOrThrow({
    where: { id: paymentId },
    select: REFUND_OWED_SELECT,
  });
  const marker = markerFromRow(row);
  if (!marker) throw new Error(`payment ${paymentId} owes nothing`);
  return driveRefundOwed(marker);
}

beforeEach(() => {
  refundDoor.refundBookingPayment.mockReset();
});

describe("earnings wait for a plan-end refund that is still owed", () => {
  it("a failing plan-end refund holds both arms past their hold; a successful re-drive clears the marker and releases them", async () => {
    const s = await seedEndedPlan();
    await settleWithFailingGatewayAndLetHoldsLapse(s);

    await releaseEarningsFromHold();
    let now = await statuses(s);
    expect(now.consultant.status).toBe("PENDING");
    expect(now.org.status).toBe("PENDING");

    refundDoor.refundBookingPayment.mockImplementation(
      async (args: { amountPaise?: number }) => ({
        refundId: `rf_${randomUUID()}`,
        amountRefundedPaise: args.amountPaise ?? PRICE,
        status: "SUCCEEDED",
      }),
    );
    expect((await redrive(s.paymentId)).kind).toBe("refunded");
    expect(
      (
        await prisma.payment.findUniqueOrThrow({
          where: { id: s.paymentId },
          select: { refundOwedKey: true },
        })
      ).refundOwedKey,
    ).toBeNull();

    await releaseEarningsFromHold();
    now = await statuses(s);
    expect(now.consultant.status).toBe("READY");
    expect(now.org.status).toBe("READY");
  });

  it("a marker whose attempts are spent keeps both arms held until support settles it by hand", async () => {
    const s = await seedEndedPlan();
    await settleWithFailingGatewayAndLetHoldsLapse(s);

    for (let i = 1; i < MAX_REFUND_OWED_ATTEMPTS; i += 1) {
      expect(await redrive(s.paymentId)).toMatchObject({ kind: "failed" });
    }
    const spent = await prisma.payment.findUniqueOrThrow({
      where: { id: s.paymentId },
      select: { refundOwedKey: true, refundOwedAttempts: true },
    });
    expect(spent.refundOwedKey).not.toBeNull();
    expect(spent.refundOwedAttempts).toBe(MAX_REFUND_OWED_ATTEMPTS);

    await releaseEarningsFromHold();
    let now = await statuses(s);
    expect(now.consultant.status).toBe("PENDING");
    expect(now.org.status).toBe("PENDING");

    await prisma.$transaction((tx) =>
      settleOwedByHand(tx, s.paymentId, { kind: "whole" }),
    );
    await releaseEarningsFromHold();
    now = await statuses(s);
    expect(now.consultant.status).toBe("READY");
    expect(now.org.status).toBe("READY");
  });
});
