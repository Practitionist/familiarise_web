/**
 * The plan end, a cancel and an approved session-count support remedy, on
 * real Postgres. The plan end waits while that remedy's refund is not live,
 * and a cancel never quotes its sessions, so they are paid once; once the plan
 * settled without them, the remedy's refund is still owed: a retry pays it and
 * a void is refused. The buyer ends whole in every order.
 */
import { randomUUID } from "node:crypto";
import prisma from "../../../lib/prisma";
import {
  performCaseAction,
  readCaseResolution,
} from "../../../lib/support/case-actions";
import { resolveBookingRefundContext } from "../../../lib/booking/cancellation-scope";
import { quoteBookingRefund } from "../../../lib/payments/operations/cancellation-policy";
import { caseVersion, rowId, seedCase, seedUser } from "../seed";
import { HOUR_MS, seedConsultee, seedHost } from "./harness";
import { refundDoor } from "./harness-edges";
import { seedCardPayment } from "./harness-plans";

jest.mock("../../../lib/novu", () =>
  jest.requireActual("../../fixtures/noop-module").noopModule(),
);
jest.mock("../../../lib/novu/service", () =>
  jest.requireActual("../../fixtures/noop-module").noopModule(),
);
jest.mock("../../../lib/novu/stage-then-attempt", () =>
  jest.requireActual("./harness-edges").noFlushMock(),
);

import {
  planEndRefundKey,
  settleCancelledSessions,
} from "../../../scripts/appointments/settle-cancelled-sessions";

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
  const payment = await seedCardPayment(buyer.userId, appointment.id, PRICE);
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
    .filter(
      (args) => args.dedupeKey === planEndRefundKey(subscriptionId, paymentId),
    )
    .map((args) => args.amountPaise);

const voidAs = async (caseId: string, recommendationId: string) =>
  performCaseAction(caseId, await seedUser("ADMIN"), {
    action: "VOID_RECOMMENDATION",
    clientActionId: randomUUID(),
    expectedUpdatedAt: await caseVersion(caseId),
    recommendationId,
    reason: "Gateway refused; refunding by bank transfer",
  });

/** The support door's sends for a recommendation, in order. */
const supportCalls = (recommendationId: string) =>
  refundDoor.refundBookingPayment.mock.calls
    .map(([args]) => args as { dedupeKey?: string; amountPaise?: number })
    .filter(
      (args) => args.dedupeKey === `case-recommendation:${recommendationId}`,
    )
    .map((args) => args.amountPaise);

/** The decider retries the approved remedy, as the case's money door would. */
async function retryAsDecider(
  caseId: string,
  recommendationId: string,
  refundablePaise: number,
) {
  const { decidedById } =
    await prisma.supportFinancialRecommendation.findUniqueOrThrow({
      where: { id: recommendationId },
      select: { decidedById: true },
    });
  const decider = await prisma.user.findUniqueOrThrow({
    where: { id: decidedById ?? "" },
    select: { id: true, role: true },
  });
  return performCaseAction(
    caseId,
    { userId: decider.id, role: decider.role },
    {
      action: "REVIEW_REFUND",
      clientActionId: randomUUID(),
      expectedUpdatedAt: await caseVersion(caseId),
      recommendationId,
      approve: true,
      reason: "Retrying the refund",
      expectedRefundablePaise: refundablePaise,
    },
  );
}

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
    const recommendationId = await approveOneSession(
      plan.caseId,
      plan.paymentId,
    );
    await bindRefund(recommendationId, plan.paymentId, "FAILED");
    await endPlan(plan.subscriptionId);

    await settleCancelledSessions();
    expect((await subscriptionOf(plan.subscriptionId)).status).toBe("APPROVED");
    expect(planEndCalls(plan.subscriptionId, plan.paymentId)).toEqual([]);

    await voidAs(plan.caseId, recommendationId);
    expect((await subscriptionOf(plan.subscriptionId)).sessionsRefunded).toBe(
      0,
    );

    await settleCancelledSessions();
    expect((await subscriptionOf(plan.subscriptionId)).status).toBe(
      "COMPLETED",
    );
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

  it("settles net of a sent remedy; if that refund later fails, the retry pays it and a void is refused", async () => {
    const plan = await seedPlanCase();
    const recommendationId = await approveOneSession(
      plan.caseId,
      plan.paymentId,
    );
    const refundId = await bindRefund(
      recommendationId,
      plan.paymentId,
      "SUCCEEDED",
    );
    await endPlan(plan.subscriptionId);

    await settleCancelledSessions();
    expect((await subscriptionOf(plan.subscriptionId)).status).toBe(
      "COMPLETED",
    );
    // floor(100,000 × 2 / 4) − 25,000 already returned.
    expect(planEndCalls(plan.subscriptionId, plan.paymentId)).toEqual([25_000]);

    // The support refund fails after the plan settled.
    await prisma.refund.update({
      where: { id: refundId },
      data: { status: "FAILED", failedAt: new Date() },
    });
    // The settled plan cannot take the session back, so a void is refused.
    await expect(voidAs(plan.caseId, recommendationId)).rejects.toEqual(
      expect.objectContaining({ code: "NOT_VOIDABLE" }),
    );

    await retryAsDecider(plan.caseId, recommendationId, PRICE);
    // The buyer ends whole: 25,000 support + 25,000 plan end = 2 sessions' worth.
    expect(supportCalls(recommendationId)).toEqual([25_000, 25_000]);
    expect(
      25_000 + (planEndCalls(plan.subscriptionId, plan.paymentId)[0] ?? 0),
    ).toBe(PRICE / 2);
  });
});

describe("cancel vs a session-count remedy", () => {
  it("a failed remedy then a cancel: the cancel skips its session and the retry pays it", async () => {
    const plan = await seedPlanCase();
    const recommendationId = await approveOneSession(
      plan.caseId,
      plan.paymentId,
    );
    await bindRefund(recommendationId, plan.paymentId, "FAILED");
    // The cancel quote owes the 1 session still unheld (4 − 2 delivered − 1 removed).
    const ctx = await resolveBookingRefundContext({
      subscriptionId: plan.subscriptionId,
    });
    const quote = quoteBookingRefund({
      policy: ctx.policy,
      hoursUntilNextSession: ctx.hoursUntilNextSession,
      slotsTotal: ctx.slotsTotal,
      sessionsRemaining: ctx.sessionsRemaining,
      sessionsTotal: ctx.sessionsTotal,
      sessionsRefunded: ctx.sessionsRefunded,
      sessionsCompleted: ctx.sessionsCompleted,
      scheduledStarts: ctx.scheduledStarts,
      alreadyRefundedPaise: ctx.alreadyRefundedPaise,
      isSubscription: true,
      isConsultantInitiated: true,
      isFreeCreditFunded: false,
      grossPaise: ctx.paidPayment?.amountPaise ?? 0,
      refundablePaise: ctx.paidPayment?.refundablePaise ?? 0,
    });
    expect(quote.refundPaise).toBe(25_000);
    await prisma.subscription.update({
      where: { id: plan.subscriptionId },
      data: { status: "CANCELLED" },
    });

    await expect(voidAs(plan.caseId, recommendationId)).rejects.toEqual(
      expect.objectContaining({ code: "NOT_VOIDABLE" }),
    );
    await retryAsDecider(plan.caseId, recommendationId, PRICE);
    // 25,000 cancel + 25,000 support = the 2 undelivered sessions' worth.
    expect(quote.refundPaise + (supportCalls(recommendationId)[1] ?? 0)).toBe(
      PRICE / 2,
    );
  });
});

describe("the case resolution's plan block", () => {
  it("reads a plan only through a payment in the case's financial scope", async () => {
    const plan = await seedPlanCase();
    const payment = await prisma.payment.findUniqueOrThrow({
      where: { id: plan.paymentId },
      select: { userId: true, appointmentId: true },
    });
    const appointmentId = payment.appointmentId ?? "";
    const staff = await seedUser("STAFF");
    const own = await seedCase(payment.userId ?? "", { appointmentId });
    const stranger = await seedUser();
    const other = await seedCase(stranger.userId, { appointmentId });

    expect((await readCaseResolution(own.id, staff))?.planRefund).toEqual(
      expect.objectContaining({ paymentId: plan.paymentId }),
    );
    // Someone else's payment on the booking: no plan block, and no throw.
    expect((await readCaseResolution(other.id, staff))?.planRefund).toBeNull();
  });
});
