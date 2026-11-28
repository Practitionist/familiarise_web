/**
 * A subscription's voided session is paid back exactly once, on real Postgres:
 *  - auto-complete never completes a plan early while a void is unsettled or a
 *    past session is still undecided, so plan-end settlement owns the money;
 *  - at plan end the undelivered share is refunded once through the owed marker;
 *  - a plan that is already COMPLETED with an unsettled void goes through the
 *    same money settlement instead of a no-money stamp.
 */
import { randomUUID } from "node:crypto";
import type { AppointmentStatus } from "@prisma/client";
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
// A past session left SCHEDULED is one the slot pass has not decided yet.
jest.mock("../../../lib/booking/session-outcome-sweep", () => ({
  ...jest.requireActual("../../../lib/booking/session-outcome-sweep"),
  decideSlotOutcome: jest.fn(async () => ({
    kind: "deferred",
    reason: "stream-budget",
  })),
  alertStaleNeedsHuman: jest.fn(async () => undefined),
}));

import { autoCompleteAppointments } from "../../../scripts/appointments/auto-complete-appointments";
import {
  confirmSessionOutcome,
  setSessionOutcome,
} from "../../../lib/backoffice/session-outcomes";
import { createOrReuseSupportCase } from "../../../lib/support/case-service";
import { intakeFor } from "../seed";
import {
  planEndRefundKey,
  settleCancelledSessions,
} from "../../../scripts/appointments/settle-cancelled-sessions";

const refundDoor = jest.requireMock(
  "../../../lib/payments/operations/booking-refund",
) as { refundBookingPayment: jest.Mock };

const DAY_MS = 24 * HOUR_MS;
const PRICE = 100_000;

type SessionShape = "COMPLETED" | "VOIDED" | "SCHEDULED";

/** A 4-session weekly plan bought 25 days ago, its sessions all in the past. */
async function seedPlan(opts: {
  status: AppointmentStatus;
  sessions: SessionShape[];
  planEndsAt: Date;
}) {
  const host = await seedHost();
  const buyer = await seedConsultee();
  const now = Date.now();
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
      status: opts.status,
      bookingSource: "DIRECT_CHECKOUT",
      sessionsTotal: 4,
      schedulingPeriodStartsAt: new Date(now - 25 * DAY_MS),
      schedulingPeriodEndsAt: new Date(now - 18 * DAY_MS),
      planEndsAt: opts.planEndsAt,
      schedulingTimezone: "UTC",
    },
  });
  const appointment = await prisma.appointment.create({
    data: { appointmentType: "SUBSCRIPTION", subscriptionId: subscription.id },
  });
  // Oldest first, a day apart, every one ended well before the 1 h buffer.
  const occurrenceIds: string[] = [];
  for (const [i, shape] of opts.sessions.entries()) {
    const startsAt = new Date(
      now - (opts.sessions.length - i + 1) * DAY_MS - 3 * HOUR_MS,
    );
    const row = await prisma.appointmentOccurrence.create({
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
    occurrenceIds.push(row.id);
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
  return {
    subscriptionId: subscription.id,
    appointmentId: appointment.id,
    paymentId: payment.id,
    occurrenceIds,
  };
}

const statusOf = async (subscriptionId: string) =>
  (
    await prisma.subscription.findUniqueOrThrow({
      where: { id: subscriptionId },
    })
  ).status;

const unsettledVoids = (appointmentId: string) =>
  prisma.appointmentOccurrence.count({
    where: { appointmentId, completionStatus: "VOIDED", seatsSettledAt: null },
  });

/** The front-door calls made for one payment, as `{ key, amount }`. */
const refundsFor = (paymentId: string) =>
  refundDoor.refundBookingPayment.mock.calls
    .map(
      ([args]) =>
        args as { paymentId: string; dedupeKey: string; amountPaise?: number },
    )
    .filter((args) => args.paymentId === paymentId)
    .map((args) => ({ key: args.dedupeKey, amount: args.amountPaise }));

const endPlan = (subscriptionId: string) =>
  prisma.subscription.update({
    where: { id: subscriptionId },
    data: { planEndsAt: new Date(Date.now() - HOUR_MS) },
  });

beforeEach(() => {
  refundDoor.refundBookingPayment.mockReset();
  refundDoor.refundBookingPayment.mockImplementation(
    async (args: { amountPaise?: number }) => ({
      refundId: `rf_${randomUUID()}`,
      amountRefundedPaise: args.amountPaise ?? PRICE,
      status: "SUCCEEDED",
    }),
  );
});

describe("subscription completion vs voids", () => {
  it("3 delivered + 1 void unreplaced: never completed early; at plan end the void is refunded once", async () => {
    const plan = await seedPlan({
      status: "APPROVED",
      sessions: ["COMPLETED", "COMPLETED", "VOIDED", "COMPLETED"],
      planEndsAt: new Date(Date.now() + 5 * DAY_MS),
    });

    await autoCompleteAppointments();
    expect(await statusOf(plan.subscriptionId)).toBe("APPROVED");

    await endPlan(plan.subscriptionId);
    await settleCancelledSessions();
    await settleCancelledSessions();

    expect(await statusOf(plan.subscriptionId)).toBe("COMPLETED");
    expect(await unsettledVoids(plan.appointmentId)).toBe(0);
    expect(refundsFor(plan.paymentId)).toEqual([
      {
        key: planEndRefundKey(plan.subscriptionId, plan.paymentId),
        amount: PRICE / 4,
      },
    ]);
  });

  it("a void whose replacement filled the entitlement does not complete the plan early", async () => {
    const plan = await seedPlan({
      status: "APPROVED",
      sessions: ["COMPLETED", "VOIDED", "COMPLETED", "COMPLETED", "COMPLETED"],
      planEndsAt: new Date(Date.now() + 5 * DAY_MS),
    });

    await autoCompleteAppointments();
    expect(await statusOf(plan.subscriptionId)).toBe("APPROVED");
    expect(await unsettledVoids(plan.appointmentId)).toBe(1);

    // Every session of the entitlement was delivered: plan end owes nothing.
    await endPlan(plan.subscriptionId);
    await settleCancelledSessions();
    expect(await statusOf(plan.subscriptionId)).toBe("COMPLETED");
    expect(await unsettledVoids(plan.appointmentId)).toBe(0);
    expect(refundsFor(plan.paymentId)).toEqual([]);
  });

  it("a past session the slot pass has not decided holds completion", async () => {
    const plan = await seedPlan({
      status: "APPROVED",
      sessions: ["COMPLETED", "COMPLETED", "COMPLETED", "SCHEDULED"],
      planEndsAt: new Date(Date.now() + 5 * DAY_MS),
    });

    await autoCompleteAppointments();
    expect(await statusOf(plan.subscriptionId)).toBe("APPROVED");
  });

  it("a COMPLETED plan with an unsettled void is refunded its share once, not stamped for free", async () => {
    const plan = await seedPlan({
      status: "COMPLETED",
      sessions: ["COMPLETED", "COMPLETED", "VOIDED", "COMPLETED"],
      planEndsAt: new Date(Date.now() + 5 * DAY_MS),
    });

    await settleCancelledSessions();
    await settleCancelledSessions();

    expect(await unsettledVoids(plan.appointmentId)).toBe(0);
    expect(refundsFor(plan.paymentId)).toEqual([
      {
        key: planEndRefundKey(plan.subscriptionId, plan.paymentId),
        amount: PRICE / 4,
      },
    ]);
  });

  it("a COMPLETED plan whose void was replaced owes nothing and is only stamped", async () => {
    const plan = await seedPlan({
      status: "COMPLETED",
      sessions: ["COMPLETED", "VOIDED", "COMPLETED", "COMPLETED", "COMPLETED"],
      planEndsAt: new Date(Date.now() + 5 * DAY_MS),
    });

    await settleCancelledSessions();

    expect(await unsettledVoids(plan.appointmentId)).toBe(0);
    expect(refundsFor(plan.paymentId)).toEqual([]);
  });

  it("a CANCELLED plan's void is stamped without money (its cancel quote paid it)", async () => {
    const plan = await seedPlan({
      status: "CANCELLED",
      sessions: ["COMPLETED", "VOIDED"],
      planEndsAt: new Date(Date.now() + 5 * DAY_MS),
    });

    await settleCancelledSessions();

    expect(await unsettledVoids(plan.appointmentId)).toBe(0);
    expect(refundsFor(plan.paymentId)).toEqual([]);
  });
});

/** The void cut short and still unconfirmed, the expert's "I was there" filed inside its window. */
async function disputedCutShort(plan: {
  appointmentId: string;
  occurrenceIds: string[];
}) {
  const voidId = plan.occurrenceIds[2];
  const verdictAt = new Date(Date.now() - 2 * HOUR_MS);
  const voided = await prisma.appointmentOccurrence.update({
    where: { id: voidId },
    data: {
      outcome: "CUT_SHORT",
      outcomeAt: verdictAt,
      outcomeConfirmedAt: null,
    },
    select: {
      appointment: {
        select: {
          subscription: {
            select: {
              subscriptionPlan: {
                select: { consultantProfile: { select: { userId: true } } },
              },
            },
          },
        },
      },
    },
  });
  const hostUserId =
    voided.appointment.subscription!.subscriptionPlan.consultantProfile.userId;
  const { supportCase } = await createOrReuseSupportCase(
    intakeFor(hostUserId, {
      category: "NO_SHOW",
      appointmentId: plan.appointmentId,
      appointmentOccurrenceId: voidId,
    }),
  );
  await prisma.supportCase.update({
    where: { id: supportCase.id },
    data: { flowReason: "provider_attended", flowReasonAt: new Date() },
  });
  return voidId;
}

describe("plan-end settlement and an unconfirmed void", () => {
  it("a disputed, unconfirmed cut-short void keeps an ended plan open and unrefunded until ops confirm it", async () => {
    const plan = await seedPlan({
      status: "APPROVED",
      sessions: ["COMPLETED", "COMPLETED", "VOIDED", "COMPLETED"],
      planEndsAt: new Date(Date.now() - HOUR_MS),
    });
    const voidId = await disputedCutShort(plan);

    await settleCancelledSessions();
    expect(await statusOf(plan.subscriptionId)).toBe("APPROVED");
    expect(await unsettledVoids(plan.appointmentId)).toBe(1);
    expect(refundsFor(plan.paymentId)).toEqual([]);

    await prisma.$transaction((tx) =>
      confirmSessionOutcome(tx, { occurrenceId: voidId, outcome: "CUT_SHORT" }),
    );
    await settleCancelledSessions();
    expect(await statusOf(plan.subscriptionId)).toBe("COMPLETED");
    expect(await unsettledVoids(plan.appointmentId)).toBe(0);
    expect(refundsFor(plan.paymentId)).toEqual([
      {
        key: planEndRefundKey(plan.subscriptionId, plan.paymentId),
        amount: PRICE / 4,
      },
    ]);
  });

  it("a completed plan's unconfirmed void is neither refunded nor stamped; overturned to held, nothing is owed", async () => {
    const plan = await seedPlan({
      status: "COMPLETED",
      sessions: ["COMPLETED", "COMPLETED", "VOIDED", "COMPLETED"],
      planEndsAt: new Date(Date.now() - HOUR_MS),
    });
    const voidId = await disputedCutShort(plan);

    await settleCancelledSessions();
    expect(await unsettledVoids(plan.appointmentId)).toBe(1);
    expect(refundsFor(plan.paymentId)).toEqual([]);

    const ops = await seedConsultee();
    await prisma.$transaction((tx) =>
      setSessionOutcome(tx, {
        occurrenceId: voidId,
        outcome: "HELD",
        actorUserId: ops.userId,
      }),
    );
    await settleCancelledSessions();
    expect(await unsettledVoids(plan.appointmentId)).toBe(0);
    expect(refundsFor(plan.paymentId)).toEqual([]);
  });
});
