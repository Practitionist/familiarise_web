/**
 * An ended plan whose refund is owed keeps its host's earnings held, on real
 * Postgres: the plan-end settlement stamps the tranche holds and the owed
 * marker in one commit, the gateway keeps failing, and once the holds have run
 * out neither the consultant nor the host-organisation earning is released
 * until the marker clears (a successful re-drive, or support settling it by
 * hand after the drive's attempts are spent). An ambiguous gateway answer
 * spends no attempt, the reconciled refund clears its own marker, and a hand
 * refund after the owed refund went out is refused rather than paid twice.
 */
import { randomUUID } from "node:crypto";
import prisma from "../../../lib/prisma";
import { HOUR_MS, seedConsultee, seedHost } from "./harness";

jest.mock("../../../lib/novu", () =>
  jest.requireActual("../../fixtures/noop-module").noopModule(),
);
jest.mock("../../../lib/novu/service", () =>
  jest.requireActual("../../fixtures/noop-module").noopModule(),
);
jest.mock("../../../lib/novu/stage-then-attempt", () => ({
  __esModule: true,
  flushNotificationsAfter: jest.fn(async () => undefined),
}));

import { Prisma } from "@prisma/client";
import {
  applyRefundCascade,
  RefundGatewayError,
} from "../../../lib/payments/operations/refund";
import { readStuckOwedRefunds } from "../../../lib/backoffice/needs-human";
import {
  driveRefundOwed,
  failRefund,
  markerFromRow,
  MAX_REFUND_OWED_ATTEMPTS,
  REFUND_OWED_SELECT,
  refuseIfOwedAlreadySent,
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

/** The next drive reserves its refund under `key`, then its gateway call times out. */
function nextDriveTimesOut(key: string): { id: string } {
  const reservation = { id: "" };
  refundDoor.refundBookingPayment.mockImplementationOnce(
    async (args: { paymentId: string; amountPaise?: number }) => {
      const row = await prisma.refund.create({
        data: {
          paymentId: args.paymentId,
          amountPaise: BigInt(args.amountPaise ?? PRICE),
          status: "PENDING",
          refundId: `rfnd_pending_${randomUUID()}`,
          dedupeKey: key,
          paymentGateway: "RAZORPAY",
        },
      });
      reservation.id = row.id;
      throw new RefundGatewayError(
        "gateway timeout",
        "GATEWAY_REFUND_FAILED",
        row.id,
      );
    },
  );
  return reservation;
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

  it("an ambiguous gateway answer spends no attempt, and reconciling its refund clears the marker and releases both arms", async () => {
    const s = await seedEndedPlan();
    await settleWithFailingGatewayAndLetHoldsLapse(s);
    expect(await redrive(s.paymentId)).toMatchObject({ kind: "failed" });
    const key = planEndRefundKey(s.subscriptionId, s.paymentId);

    // The last attempt's gateway call times out: its reservation stays PENDING.
    const reservation = nextDriveTimesOut(key);
    expect(await redrive(s.paymentId)).toMatchObject({
      kind: "refunded",
      refund: { status: "PENDING" },
    });
    const kept = await prisma.payment.findUniqueOrThrow({
      where: { id: s.paymentId },
      select: { refundOwedKey: true, refundOwedAttempts: true },
    });
    expect(kept).toEqual({
      refundOwedKey: key,
      refundOwedAttempts: MAX_REFUND_OWED_ATTEMPTS - 1,
    });

    // Reconcile finds the refund went out and settles it, as its sweep does.
    await prisma.$transaction(
      async (tx) => {
        await tx.refund.updateMany({
          where: { id: reservation.id, status: "PENDING" },
          data: { status: "SUCCEEDED" },
        });
        await applyRefundCascade(tx, {
          paymentId: s.paymentId,
          refundId: reservation.id,
          amountPaise: PRICE / 4,
          reason: "Gateway refund reconciled",
          initiatedByUserId: null,
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
    expect(
      (
        await prisma.payment.findUniqueOrThrow({
          where: { id: s.paymentId },
          select: { refundOwedKey: true },
        })
      ).refundOwedKey,
    ).toBeNull();

    await releaseEarningsFromHold();
    const now = await statuses(s);
    expect(now.consultant.status).toBe("READY");
    expect(now.org.status).toBe("READY");
  });

  it("a hand refund after the owed refund went out is refused, and the stale marker clears so the earnings release", async () => {
    const s = await seedEndedPlan();
    await settleWithFailingGatewayAndLetHoldsLapse(s);
    const key = planEndRefundKey(s.subscriptionId, s.paymentId);
    // A spent marker whose own refund in fact succeeded and has been applied.
    await prisma.refund.create({
      data: {
        paymentId: s.paymentId,
        amountPaise: BigInt(PRICE / 4),
        status: "SUCCEEDED",
        cascadedAt: new Date(),
        refundId: `rfnd_done_${randomUUID()}`,
        dedupeKey: key,
        paymentGateway: "RAZORPAY",
      },
    });
    await prisma.payment.update({
      where: { id: s.paymentId },
      data: { refundOwedAttempts: MAX_REFUND_OWED_ATTEMPTS },
    });

    await expect(
      prisma.$transaction((tx) =>
        settleOwedByHand(tx, s.paymentId, { kind: "whole" }),
      ),
    ).rejects.toMatchObject({ code: "OWED_REFUND_ALREADY_SENT" });
    await expect(
      refuseIfOwedAlreadySent(s.paymentId, key),
    ).rejects.toMatchObject({
      code: "OWED_REFUND_ALREADY_SENT",
    });
    const refunds = await prisma.refund.count({
      where: { paymentId: s.paymentId },
    });
    expect(refunds).toBe(1);

    await releaseEarningsFromHold();
    const now = await statuses(s);
    expect(now.consultant.status).toBe("READY");
    expect(now.org.status).toBe("READY");
  });

  it("three ambiguous answers that reconcile fails spend the marker and list it for a human", async () => {
    const s = await seedEndedPlan();
    await settleWithFailingGatewayAndLetHoldsLapse(s);
    const key = planEndRefundKey(s.subscriptionId, s.paymentId);
    // The settlement's failed drive spent one attempt; start the loop from zero.
    await prisma.payment.update({
      where: { id: s.paymentId },
      data: { refundOwedAttempts: 0, refundOwedNextAt: null },
    });

    for (let cycle = 0; cycle < MAX_REFUND_OWED_ATTEMPTS; cycle += 1) {
      const reservation = nextDriveTimesOut(key);
      expect(await redrive(s.paymentId)).toMatchObject({ kind: "refunded" });
      // Reconcile finds no such refund at the gateway and fails it.
      await failRefund(reservation.id, (tx) =>
        tx.refund.updateMany({
          where: { id: reservation.id, status: "PENDING" },
          data: { status: "FAILED", failedAt: new Date() },
        }),
      );
      // The next drive frees the failed key, as the front door's replay check does.
      await prisma.refund.updateMany({
        where: { id: reservation.id },
        data: { dedupeKey: null },
      });
    }

    const spent = await prisma.payment.findUniqueOrThrow({
      where: { id: s.paymentId },
      select: { refundOwedKey: true, refundOwedAttempts: true },
    });
    expect(spent).toEqual({
      refundOwedKey: key,
      refundOwedAttempts: MAX_REFUND_OWED_ATTEMPTS,
    });
    const queue = await readStuckOwedRefunds();
    expect(queue.map((item) => item.paymentId)).toContain(s.paymentId);
    const pages = await prisma.systemEvent.count({
      where: {
        message: { contains: `Refund owed on payment ${s.paymentId} failed` },
      },
    });
    expect(pages).toBe(1);

    await releaseEarningsFromHold();
    const now = await statuses(s);
    expect(now.consultant.status).toBe("PENDING");
    expect(now.org.status).toBe("PENDING");
  });

  it("a refund under another key leaves the marker, and the earnings stay held", async () => {
    const s = await seedEndedPlan();
    await settleWithFailingGatewayAndLetHoldsLapse(s);
    const key = planEndRefundKey(s.subscriptionId, s.paymentId);
    const other = await prisma.refund.create({
      data: {
        paymentId: s.paymentId,
        amountPaise: BigInt(1_000),
        status: "SUCCEEDED",
        refundId: `rfnd_other_${randomUUID()}`,
        dedupeKey: `admin-refund:ops:${s.paymentId}:${randomUUID()}`,
        paymentGateway: "RAZORPAY",
      },
    });
    await prisma.$transaction(
      (tx) =>
        applyRefundCascade(tx, {
          paymentId: s.paymentId,
          refundId: other.id,
          amountPaise: 1_000,
          reason: "goodwill",
          initiatedByUserId: null,
        }),
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );

    expect(
      (
        await prisma.payment.findUniqueOrThrow({
          where: { id: s.paymentId },
          select: { refundOwedKey: true },
        })
      ).refundOwedKey,
    ).toBe(key);
    await releaseEarningsFromHold();
    const now = await statuses(s);
    expect(now.consultant.status).toBe("PENDING");
    expect(now.org.status).toBe("PENDING");
  });
});
