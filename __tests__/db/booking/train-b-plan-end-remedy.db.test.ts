/**
 * The plan end and an approved session-count support remedy, on real
 * Postgres. The plan waits while that remedy's refund is not live, so its
 * sessions are never paid twice; once the plan settles, the remedy can only
 * be voided (no retry), and the void gives nothing back to a settled plan.
 */
import { randomUUID } from "node:crypto";
import prisma from "../../../lib/prisma";
import { performCaseAction } from "../../../lib/support/case-actions";
import { caseVersion, rowId, seedCase, seedUser } from "../seed";
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

import {
  planEndRefundKey,
  settleCancelledSessions,
} from "../../../scripts/appointments/settle-cancelled-sessions";

const refundDoor = jest.requireMock(
  "../../../lib/payments/operations/booking-refund",
) as { refundBookingPayment: jest.Mock };

const DAY_MS = 24 * HOUR_MS;
const PRICE = 100_000; // 4 sessions at ₹250

/** A 4-session plan with 2 delivered, a paid card payment and a case on it. */
async function seedPlanCase() {
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
      status: "APPROVED",
      bookingSource: "DIRECT_CHECKOUT",
      sessionsTotal: 4,
      sessionsPerWeek: 1,
      sessionMinutes: 60,
      schedulingPeriodStartsAt: new Date(now - 20 * DAY_MS),
      schedulingPeriodEndsAt: new Date(now - 13 * DAY_MS),
      planEndsAt: new Date(now + 8 * DAY_MS),
      schedulingTimezone: "UTC",
    },
  });
  const appointment = await prisma.appointment.create({
    data: { appointmentType: "SUBSCRIPTION", subscriptionId: subscription.id },
  });
  for (const ordinal of [1, 2]) {
    const startsAt = new Date(now - (20 - ordinal * 7) * DAY_MS);
    await prisma.appointmentOccurrence.create({
      data: {
        appointmentId: appointment.id,
        ordinal,
        startsAt,
        endsAt: new Date(startsAt.getTime() + HOUR_MS),
        isTentative: false,
        consultantProfileId: host.consultantProfileId,
        completionStatus: "COMPLETED",
        completedAt: startsAt,
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
  const supportCase = await seedCase(buyer.userId, {
    category: "PAYMENT_ISSUE",
    subjects: [
      { subjectType: "PAYMENT", subjectId: payment.id, isPrimary: true },
    ],
  });
  return {
    subscriptionId: subscription.id,
    paymentId: payment.id,
    caseId: supportCase.id,
  };
}

/** Recommends and approves a 1-session remedy (₹250). */
async function approveOneSession(caseId: string, paymentId: string) {
  const recommendation = await performCaseAction(
    caseId,
    await seedUser("STAFF"),
    {
      action: "RECOMMEND_REFUND",
      clientActionId: randomUUID(),
      expectedUpdatedAt: await caseVersion(caseId),
      paymentId,
      amountPaise: 25_000,
      reason: "The expert missed a session",
      releaseSeat: false,
      sessions: 1,
    },
  );
  await performCaseAction(caseId, await seedUser("STAFF"), {
    action: "REVIEW_REFUND",
    clientActionId: randomUUID(),
    expectedUpdatedAt: await caseVersion(caseId),
    recommendationId: rowId(recommendation),
    approve: true,
    reason: "Checked the session log",
    expectedRefundablePaise: PRICE,
  });
  return rowId(recommendation);
}

/** Binds a refund row in `status` to the recommendation, as the door would. */
async function bindRefund(
  recommendationId: string,
  paymentId: string,
  status: "FAILED" | "SUCCEEDED",
) {
  const refund = await prisma.refund.create({
    data: {
      paymentId,
      amountPaise: BigInt(25_000),
      status,
      refundId: `rfnd_${status.toLowerCase()}_${randomUUID()}`,
      paymentGateway: "RAZORPAY",
      ...(status === "FAILED" ? { failedAt: new Date() } : {}),
    },
  });
  await prisma.supportFinancialRecommendation.update({
    where: { id: recommendationId },
    data: { refundId: refund.id },
  });
  return refund.id;
}

const subscriptionOf = (id: string) =>
  prisma.subscription.findUniqueOrThrow({ where: { id } });

const endPlan = (subscriptionId: string) =>
  prisma.subscription.update({
    where: { id: subscriptionId },
    data: { planEndsAt: new Date(Date.now() - HOUR_MS) },
  });

const planEndCalls = (subscriptionId: string, paymentId: string) =>
  refundDoor.refundBookingPayment.mock.calls
    .map(([args]) => args as { dedupeKey?: string; amountPaise?: number })
    .filter((args) => args.dedupeKey === planEndRefundKey(subscriptionId, paymentId))
    .map((args) => args.amountPaise);

const voidAs = async (caseId: string, recommendationId: string) =>
  performCaseAction(caseId, await seedUser("ADMIN"), {
    action: "VOID_RECOMMENDATION",
    clientActionId: randomUUID(),
    expectedUpdatedAt: await caseVersion(caseId),
    recommendationId,
    reason: "Gateway refused; refunding by bank transfer",
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

describe("plan end vs a session-count remedy", () => {
  it("waits while the remedy's refund failed; a void gives the session back and the plan settles the full share", async () => {
    const plan = await seedPlanCase();
    const recommendationId = await approveOneSession(plan.caseId, plan.paymentId);
    await bindRefund(recommendationId, plan.paymentId, "FAILED");
    await endPlan(plan.subscriptionId);

    await settleCancelledSessions();
    expect((await subscriptionOf(plan.subscriptionId)).status).toBe("APPROVED");
    expect(planEndCalls(plan.subscriptionId, plan.paymentId)).toEqual([]);

    await voidAs(plan.caseId, recommendationId);
    expect((await subscriptionOf(plan.subscriptionId)).sessionsRefunded).toBe(0);

    await settleCancelledSessions();
    expect((await subscriptionOf(plan.subscriptionId)).status).toBe("COMPLETED");
    // 2 of 4 undelivered at ₹250, nothing returned.
    expect(planEndCalls(plan.subscriptionId, plan.paymentId)).toEqual([50_000]);
  });

  it("waits while the remedy's refund was never sent", async () => {
    const plan = await seedPlanCase();
    await approveOneSession(plan.caseId, plan.paymentId);
    await endPlan(plan.subscriptionId);

    await settleCancelledSessions();
    expect((await subscriptionOf(plan.subscriptionId)).status).toBe("APPROVED");
    expect(planEndCalls(plan.subscriptionId, plan.paymentId)).toEqual([]);
  });

  it("settles net of a sent remedy, then refuses a retry and voids without a give-back", async () => {
    const plan = await seedPlanCase();
    const recommendationId = await approveOneSession(plan.caseId, plan.paymentId);
    const refundId = await bindRefund(
      recommendationId,
      plan.paymentId,
      "SUCCEEDED",
    );
    await endPlan(plan.subscriptionId);

    await settleCancelledSessions();
    expect((await subscriptionOf(plan.subscriptionId)).status).toBe("COMPLETED");
    // floor(100,000 × 2 / 4) − 25,000 already returned.
    expect(planEndCalls(plan.subscriptionId, plan.paymentId)).toEqual([25_000]);

    // The support refund fails after the plan settled.
    await prisma.refund.update({
      where: { id: refundId },
      data: { status: "FAILED", failedAt: new Date() },
    });
    const decider = await prisma.supportFinancialRecommendation.findUniqueOrThrow(
      { where: { id: recommendationId }, select: { decidedById: true } },
    );
    const deciderUser = await prisma.user.findUniqueOrThrow({
      where: { id: decider.decidedById ?? "" },
      select: { id: true, role: true },
    });
    await expect(
      performCaseAction(
        plan.caseId,
        { userId: deciderUser.id, role: deciderUser.role },
        {
          action: "REVIEW_REFUND",
          clientActionId: randomUUID(),
          expectedUpdatedAt: await caseVersion(plan.caseId),
          recommendationId,
          approve: true,
          reason: "Retrying the refund",
          expectedRefundablePaise: PRICE - 25_000,
        },
      ),
    ).rejects.toEqual(expect.objectContaining({ code: "PLAN_SETTLED" }));

    await voidAs(plan.caseId, recommendationId);
    const sub = await subscriptionOf(plan.subscriptionId);
    expect(sub.status).toBe("COMPLETED");
    expect(sub.sessionsRefunded).toBe(1);
  });
});
