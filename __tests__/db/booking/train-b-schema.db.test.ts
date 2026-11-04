/**
 * The train-B schema on real Postgres: the sidecar CHECKs and partial unique,
 * purchase-time frozen terms, the plan edit that spares sold plans, and the
 * CAS on `Subscription.sessionsRefunded` (directly and through the support
 * refund door).
 */
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import prisma from "../../../lib/prisma";
import {
  removePlanSessions,
  restorePlanSessions,
} from "../../../lib/booking/plan-refund";
import { freezeSoldTerms } from "../../../lib/booking/sold-terms";
import { handleSubscriptionCheckout } from "../../../lib/payments/checkout/handlers/subscription";
import { weeksPlanEndOf } from "../../../lib/booking/entitlement";
import { checkoutSchema } from "../../../schemas/checkout";
import {
  CaseActionError,
  performCaseAction,
} from "../../../lib/support/case-actions";
import {
  caseVersion,
  raceBehindLock,
  rowId,
  seedCase,
  seedUser,
  settledValues,
} from "../seed";
import {
  seedConsultee,
  seedHost,
  seedPaidSubscription,
  type SeededHost,
} from "./harness";

async function seedPlan(
  host: SeededHost,
  data: Partial<Prisma.SubscriptionPlanUncheckedCreateInput> = {},
) {
  return prisma.subscriptionPlan.create({
    data: {
      title: "Train B plan",
      price: BigInt(1_560_000),
      consultantProfileId: host.consultantProfileId,
      ...data,
    },
  });
}

async function seedSubscription(
  planId: string,
  consulteeProfileId: string,
  data: Partial<Prisma.SubscriptionUncheckedCreateInput> = {},
) {
  const start = new Date("2026-01-05T12:30:00.000Z");
  return prisma.subscription.create({
    data: {
      subscriptionPlanId: planId,
      requestedById: consulteeProfileId,
      status: "APPROVED",
      schedulingPeriodStartsAt: start,
      schedulingPeriodEndsAt: new Date(start.getTime() + 7 * 86_400_000),
      ...data,
    },
  });
}

async function paymentOf(appointmentId: string) {
  return prisma.payment.findFirstOrThrow({ where: { appointmentId } });
}

describe("sidecar constraints", () => {
  it("bounds a weeks plan to 1..52 weeks", async () => {
    const host = await seedHost();
    await expect(seedPlan(host, { durationInWeeks: 0 })).rejects.toThrow(
      /subscription_plan_weeks_range/,
    );
    await expect(seedPlan(host, { durationInWeeks: 53 })).rejects.toThrow(
      /subscription_plan_weeks_range/,
    );
    await expect(seedPlan(host, { durationInWeeks: 26 })).resolves.toEqual(
      expect.objectContaining({ durationInWeeks: 26 }),
    );
    await expect(seedPlan(host)).resolves.toEqual(
      expect.objectContaining({ durationInWeeks: null }),
    );
  });

  it("keeps sessionsRefunded within the sessions sold and frozen terms positive", async () => {
    const host = await seedHost();
    const consultee = await seedConsultee();
    const plan = await seedPlan(host);
    await expect(
      seedSubscription(plan.id, consultee.consulteeProfileId, {
        sessionsTotal: 8,
        sessionsRefunded: 9,
      }),
    ).rejects.toThrow(/subscription_sessions_refunded_range/);
    await expect(
      seedSubscription(plan.id, consultee.consulteeProfileId, {
        sessionsRefunded: -1,
      }),
    ).rejects.toThrow(/subscription_sessions_refunded_range/);
    await expect(
      seedSubscription(plan.id, consultee.consulteeProfileId, {
        sessionsPerWeek: 0,
      }),
    ).rejects.toThrow(/subscription_frozen_terms_positive/);
    const ok = await seedSubscription(plan.id, consultee.consulteeProfileId, {
      sessionsTotal: 8,
      sessionsRefunded: 8,
      sessionsPerWeek: 2,
      sessionMinutes: 60,
    });
    expect(ok.sessionsRefunded).toBe(8);
  });

  it("allows one live Regular-time row per slot and checks its ranges", async () => {
    const host = await seedHost();
    const consultee = await seedConsultee();
    const plan = await seedPlan(host);
    const sub = await seedSubscription(plan.id, consultee.consulteeProfileId);
    const row = (data: Partial<Prisma.RegularTimeUncheckedCreateInput> = {}) =>
      prisma.regularTime.create({
        data: {
          subscriptionId: sub.id,
          weekday: 1,
          localStartMinutes: 18 * 60,
          timezone: "Asia/Kolkata",
          validFrom: new Date("2026-01-05T00:00:00.000Z"),
          createdByUserId: host.userId,
          ...data,
        },
      });
    await expect(row({ weekday: 8 })).rejects.toThrow(/regular_time_ranges/);
    await expect(row({ localStartMinutes: 1440 })).rejects.toThrow(
      /regular_time_ranges/,
    );
    const first = await row();
    await expect(row()).rejects.toThrow(/regular_time_one_live_slot/);
    await prisma.regularTime.update({
      where: { id: first.id },
      data: { validUntil: new Date("2026-02-02T00:00:00.000Z") },
    });
    await expect(row()).resolves.toEqual(
      expect.objectContaining({ validUntil: null }),
    );
  });

  it("shapes a plan-end choice by its status", async () => {
    const host = await seedHost();
    const consultee = await seedConsultee();
    const plan = await seedPlan(host);
    const choice = async (
      data: Partial<Prisma.PlanEndChoiceUncheckedCreateInput>,
    ) => {
      const sub = await seedSubscription(plan.id, consultee.consulteeProfileId);
      return prisma.planEndChoice.create({
        data: {
          subscriptionId: sub.id,
          unusedAtOffer: 8,
          offeredAt: new Date("2026-07-06T12:30:00.000Z"),
          deadline: new Date("2026-07-13T12:30:00.000Z"),
          ...data,
        },
      });
    };
    const decidedAt = new Date("2026-07-07T09:00:00.000Z");
    const previousPlanEndsAt = new Date("2026-07-06T12:30:00.000Z");
    await expect(choice({ decidedAt })).rejects.toThrow(
      /plan_end_choice_shape/,
    );
    await expect(choice({ status: "REFUNDED" })).rejects.toThrow(
      /plan_end_choice_shape/,
    );
    await expect(
      choice({ status: "EXTENDED", decidedAt, extraWeeksOffered: 3 }),
    ).rejects.toThrow(/plan_end_choice_extended/);
    await expect(
      choice({
        status: "EXTENDED",
        decidedAt,
        extraWeeksOffered: 5,
        previousPlanEndsAt,
      }),
    ).rejects.toThrow(/plan_end_choice_extended/);
    await expect(choice({ extraWeeksOffered: 3 })).resolves.toEqual(
      expect.objectContaining({ status: "OFFERED" }),
    );
    await expect(
      choice({
        status: "EXTENDED",
        decidedAt,
        extraWeeksOffered: 3,
        previousPlanEndsAt,
      }),
    ).resolves.toEqual(expect.objectContaining({ status: "EXTENDED" }));
    await expect(choice({ status: "REFUNDED", decidedAt })).resolves.toEqual(
      expect.objectContaining({ status: "REFUNDED" }),
    );
  });
});

describe("frozen purchase terms", () => {
  it("stamps cadence, length, weeks × perWeek and the weeks end at checkout", async () => {
    const host = await seedHost();
    const consultee = await seedConsultee();
    const plan = await seedPlan(host, {
      sessionsPerWeek: 3,
      sessionDurationInHours: 1.5,
      durationInMonths: 6,
      durationInWeeks: 26,
      totalSessions: 78,
    });
    const policyId = await seedPolicy();
    const start = new Date(Date.now() + 2 * 86_400_000);
    const input = checkoutSchema.parse({
      appointmentType: "SUBSCRIPTION",
      planId: plan.id,
      schedulingPeriodStartsAt: start.toISOString(),
    });
    const result = await prisma.$transaction((tx) =>
      handleSubscriptionCheckout(
        tx,
        input,
        consultee.consulteeProfileId,
        true,
        null,
        policyId,
      ),
    );
    const sub = await prisma.subscription.findUniqueOrThrow({
      where: { id: result.subscription.id },
    });
    expect(sub.sessionsPerWeek).toBe(3);
    expect(sub.sessionMinutes).toBe(90);
    expect(sub.sessionsTotal).toBe(78);
    expect(sub.sessionsRefunded).toBe(0);
    expect(sub.planEndsAt).toEqual(
      weeksPlanEndOf(sub.schedulingPeriodStartsAt, 26, sub.schedulingTimezone),
    );
  });

  it("a plan edit stamps legacy rows and never moves a sold plan", async () => {
    const host = await seedHost();
    const consultee = await seedConsultee();
    const plan = await seedPlan(host, {
      sessionsPerWeek: 2,
      sessionDurationInHours: 1,
      totalSessions: 8,
    });
    const legacy = await seedSubscription(
      plan.id,
      consultee.consulteeProfileId,
    );
    const frozen = await seedSubscription(
      plan.id,
      consultee.consulteeProfileId,
      {
        sessionsPerWeek: 1,
        sessionMinutes: 30,
        sessionsTotal: 4,
      },
    );
    await prisma.$transaction(async (tx) => {
      await freezeSoldTerms(tx, plan.id);
      await tx.subscriptionPlan.update({
        where: { id: plan.id },
        data: {
          sessionsPerWeek: 5,
          sessionDurationInHours: 2,
          totalSessions: 20,
        },
      });
    });
    const rows = await prisma.subscription.findMany({
      where: { id: { in: [legacy.id, frozen.id] } },
      select: {
        id: true,
        sessionsPerWeek: true,
        sessionMinutes: true,
        sessionsTotal: true,
      },
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(legacy.id)).toMatchObject({
      sessionsPerWeek: 2,
      sessionMinutes: 60,
      sessionsTotal: 8,
    });
    expect(byId.get(frozen.id)).toMatchObject({
      sessionsPerWeek: 1,
      sessionMinutes: 30,
      sessionsTotal: 4,
    });
  });
});

async function seedPolicy(): Promise<string> {
  const policy = await prisma.cancellationPolicy.create({
    data: {
      organizationId: null,
      version: 900 + Math.floor(Math.random() * 1_000_000),
      status: "ARCHIVED",
      consultantInitiatedBps: 10_000,
      tiers: { create: [{ hoursBefore: 0, refundBps: 10_000 }] },
    },
  });
  return policy.id;
}

describe("sessionsRefunded CAS", () => {
  it("lets one of two racing removals win and refuses the other", async () => {
    const host = await seedHost();
    const consultee = await seedConsultee();
    const { subscriptionId, appointmentId } = await seedPaidSubscription(
      host,
      consultee,
      new Date(Date.now() + 86_400_000),
    );
    const payment = await paymentOf(appointmentId);
    const remove = () =>
      prisma.$transaction((tx) => removePlanSessions(tx, payment.id, 5));
    const results = await raceBehindLock(
      Prisma.sql`SELECT 1 FROM "Subscription" WHERE id = ${subscriptionId} FOR UPDATE`,
      [remove, remove],
    );
    const { fulfilled } = settledValues(results);
    expect(fulfilled.filter((r) => r.ok)).toHaveLength(1);
    expect(fulfilled.filter((r) => !r.ok)).toEqual([
      expect.objectContaining({ ok: false, reason: "RACED" }),
    ]);
    const sub = await prisma.subscription.findUniqueOrThrow({
      where: { id: subscriptionId },
    });
    expect(sub.sessionsRefunded).toBe(5);
  });

  it("refuses more than the unheld sessions and restores on a void", async () => {
    const host = await seedHost();
    const consultee = await seedConsultee();
    const { subscriptionId, appointmentId } = await seedPaidSubscription(
      host,
      consultee,
      new Date(Date.now() + 86_400_000),
    );
    const payment = await paymentOf(appointmentId);
    await expect(
      prisma.$transaction((tx) => removePlanSessions(tx, payment.id, 9)),
    ).resolves.toEqual(
      expect.objectContaining({
        ok: false,
        reason: "EXCEEDS_REMOVABLE",
        removable: 8,
      }),
    );
    await prisma.$transaction((tx) => removePlanSessions(tx, payment.id, 3));
    await prisma.$transaction((tx) => restorePlanSessions(tx, payment.id, 3));
    const sub = await prisma.subscription.findUniqueOrThrow({
      where: { id: subscriptionId },
    });
    expect(sub.sessionsRefunded).toBe(0);
  });
});

describe("support partial refund priced in sessions", () => {
  async function planCase() {
    const host = await seedHost();
    const consultee = await seedConsultee();
    const { subscriptionId, appointmentId } = await seedPaidSubscription(
      host,
      consultee,
      new Date(Date.now() + 86_400_000),
    );
    const payment = await paymentOf(appointmentId);
    const supportCase = await seedCase(consultee.userId, {
      category: "PAYMENT_ISSUE",
      subjects: [
        { subjectType: "PAYMENT", subjectId: payment.id, isPrimary: true },
      ],
    });
    return { subscriptionId, paymentId: payment.id, caseId: supportCase.id };
  }

  it("removes k sessions in the approval's commit, at floor(A × k / T)", async () => {
    const { subscriptionId, paymentId, caseId } = await planCase();
    const proposer = await seedUser("STAFF");
    const reviewer = await seedUser("STAFF");
    // ₹4,000 for 8 sessions: 3 sessions are ₹1,500.
    const recommendation = await performCaseAction(caseId, proposer, {
      action: "RECOMMEND_REFUND",
      clientActionId: randomUUID(),
      expectedUpdatedAt: await caseVersion(caseId),
      paymentId,
      amountPaise: 150_000,
      reason: "The expert missed three sessions",
      releaseSeat: false,
      sessions: 3,
    });
    const before = await prisma.subscription.findUniqueOrThrow({
      where: { id: subscriptionId },
    });
    expect(before.sessionsRefunded).toBe(0);
    await performCaseAction(caseId, reviewer, {
      action: "REVIEW_REFUND",
      clientActionId: randomUUID(),
      expectedUpdatedAt: await caseVersion(caseId),
      recommendationId: rowId(recommendation),
      approve: true,
      reason: "Checked the session log",
      expectedRefundablePaise: 400_000,
    });
    const after = await prisma.subscription.findUniqueOrThrow({
      where: { id: subscriptionId },
    });
    expect(after.sessionsRefunded).toBe(3);
    const stored =
      await prisma.supportFinancialRecommendation.findUniqueOrThrow({
        where: { id: rowId(recommendation) },
      });
    expect(stored.sessionsRemoved).toBe(3);
  });

  it("refuses an amount that is not the sessions' share", async () => {
    const { paymentId, caseId } = await planCase();
    const proposer = await seedUser("STAFF");
    await expect(
      performCaseAction(caseId, proposer, {
        action: "RECOMMEND_REFUND",
        clientActionId: randomUUID(),
        expectedUpdatedAt: await caseVersion(caseId),
        paymentId,
        amountPaise: 160_000,
        reason: "The expert missed three sessions",
        releaseSeat: false,
        sessions: 3,
      }),
    ).rejects.toEqual(expect.objectContaining({ code: "PREVIEW_CHANGED" }));
  });

  it("refuses more sessions than the plan still has unheld", async () => {
    const { paymentId, caseId } = await planCase();
    const proposer = await seedUser("STAFF");
    const attempt = performCaseAction(caseId, proposer, {
      action: "RECOMMEND_REFUND",
      clientActionId: randomUUID(),
      expectedUpdatedAt: await caseVersion(caseId),
      paymentId,
      amountPaise: 450_000,
      reason: "The expert missed nine sessions",
      releaseSeat: false,
      sessions: 9,
    });
    await expect(attempt).rejects.toBeInstanceOf(CaseActionError);
    await expect(attempt).rejects.toEqual(
      expect.objectContaining({ code: "SESSIONS_EXCEED_PLAN" }),
    );
  });
});
