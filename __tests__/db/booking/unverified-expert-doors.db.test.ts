/**
 * An expert who is not verified takes no new booking or payment: the free and
 * paid trial, the 1:1 request, the approval pay-link and checkout's in-lock
 * re-read each refuse with EXPERT_NOT_VERIFIED and write nothing, while a
 * verified expert's still go through and a rejected expert's paid booking stays.
 */
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import type { ConsultantVerificationStatus } from "@prisma/client";
import prisma from "../../../lib/prisma";
import {
  HOUR_MS,
  futureAt,
  seedConsultee,
  seedHost,
  seedOneToOne,
  type SeededHost,
} from "./harness";
import {
  consultationCheckout,
  publishEveryHour,
  seedBuyer,
} from "./harness-host";
import { sessionUser } from "./harness-edges";

jest.mock("../../../lib/payments/index", () => ({
  __esModule: true,
  createPaymentIntent: jest.fn(async () => {
    const id = `order_${randomUUID()}`;
    return { id, client_secret: id };
  }),
  cancelPaymentIntent: jest.fn(async () => undefined),
}));
jest.mock("../../../lib/compliance/dpdp", () => ({
  __esModule: true,
  checkConsent: jest.fn(async () => true),
}));
jest.mock("../../../lib/auth-helpers", () =>
  jest.requireActual("./harness-edges").authHelpersMock(),
);
jest.mock("../../../lib/auth-server", () => ({
  getSession: async () => ({
    user: jest.requireActual("./harness-edges").sessionUser.current,
  }),
}));
jest.mock("../../../lib/rate-limit", () => ({
  ...jest.requireActual("./harness-edges").rateLimitMock(),
  trialRequestRefusal: async () => null,
  spendTrialRequest: async () => undefined,
}));
jest.mock("../../../lib/novu/stage-then-attempt", () =>
  jest.requireActual("./harness-edges").noFlushMock(),
);
jest.mock("../../../lib/novu", () => {
  const noop = jest.fn(async () => []);
  return new Proxy(
    {},
    {
      // Not a thenable: the mint loads these modules with a dynamic import.
      get: (_target, prop) =>
        prop === "then" ? undefined : prop === "__esModule" ? true : noop,
    },
  );
});
jest.mock("../../../lib/email", () => {
  const noop = jest.fn(async () => ({ success: true }));
  return new Proxy(
    {},
    {
      get: (_target, prop) =>
        prop === "then" ? undefined : prop === "__esModule" ? true : noop,
    },
  );
});
jest.mock("../../../lib/email/render", () => ({
  __esModule: true,
  renderEmail: async () => ({ html: "<p>rendered</p>", text: "rendered" }),
}));
jest.mock("../../../utils/contentValidation", () =>
  jest.requireActual("../../fixtures/content-validation-stub"),
);
/** Set to a host's profile id to reject that expert between pricing and the lock. */
const mockRejectAfterPricing = { profileId: null as string | null };
jest.mock("../../../lib/payments/checkout/pricing", () => {
  const actual = jest.requireActual("../../../lib/payments/checkout/pricing");
  return {
    ...actual,
    calculateAmountAndValidate: async (...args: unknown[]) => {
      const priced = await actual.calculateAmountAndValidate(...args);
      if (mockRejectAfterPricing.profileId) {
        await prisma.consultantProfile.update({
          where: { id: mockRejectAfterPricing.profileId },
          data: { verificationStatus: "REJECTED" },
        });
      }
      return priced;
    },
  };
});

import { POST as requestTrial } from "../../../app/api/trials/route";
import { POST as requestForApproval } from "../../../app/api/scheduling/request-for-approval/route";
import { mintApprovalPaymentAfterCommit } from "../../../lib/booking/approve-request";
import { handleCheckout } from "../../../lib/payments/checkout";
import { createApprovalPaymentIntent } from "../../../lib/payments/operations/approval-payment";
import { applyTransactionalEffects } from "../../../lib/moderation/side-effects";

const setStatus = (host: SeededHost, status: ConsultantVerificationStatus) =>
  prisma.consultantProfile.update({
    where: { id: host.consultantProfileId },
    data: { verificationStatus: status },
  });

async function seedTrialPlan(host: SeededHost, trialPricePaise: number) {
  await publishEveryHour(host);
  return prisma.subscriptionPlan.create({
    data: {
      title: "Trial plan",
      price: BigInt(400_000),
      consultantProfileId: host.consultantProfileId,
      sessionsPerWeek: 1,
      durationInMonths: 1,
      sessionDurationInHours: 1,
      totalSessions: 4,
      trialEnabled: true,
      trialDurationMinutes: 30,
      trialPriceInPaise: BigInt(trialPricePaise),
    },
  });
}

async function postTrial(host: SeededHost, planId: string) {
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
        subscriptionPlanId: planId,
        slot: {
          startsAt: startsAt.toISOString(),
          endsAt: new Date(startsAt.getTime() + 30 * 60_000).toISOString(),
        },
      }),
    }),
  );
  return { res, buyer };
}

async function postRequest(
  host: SeededHost,
  status: ConsultantVerificationStatus,
) {
  await publishEveryHour(host);
  await prisma.consultantProfile.update({
    where: { id: host.consultantProfileId },
    data: {
      acceptingRequests: true,
      bookingMode: "REQUEST",
      verificationStatus: status,
    },
  });
  const plan = await prisma.consultationPlan.create({
    data: {
      title: "Requestable consultation",
      price: BigInt(100_000),
      consultantProfileId: host.consultantProfileId,
      durationInHours: 1,
    },
  });
  const row = await prisma.availabilityWindowCustom.findFirstOrThrow({
    where: { consultantProfileId: host.consultantProfileId },
    select: { id: true },
  });
  const consultee = await seedConsultee();
  sessionUser.current = { id: consultee.userId };
  const startsAt = futureAt(6, 10);
  const res = await requestForApproval(
    new NextRequest("https://x.test/api/scheduling/request-for-approval", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": randomUUID(),
      },
      body: JSON.stringify({
        consultantProfileId: host.consultantProfileId,
        consultationPlanId: plan.id,
        availabilityWindowCustomId: row.id,
        startsAt: startsAt.toISOString(),
        endsAt: new Date(startsAt.getTime() + HOUR_MS).toISOString(),
      }),
    }),
  );
  return { res, planId: plan.id };
}

describe("an expert who is not verified takes no new booking", () => {
  it.each([
    ["free", 0],
    ["paid", 50_000],
  ])(
    "a %s trial is refused and writes nothing",
    async (_kind, price) => {
      const host = await seedHost();
      const plan = await seedTrialPlan(host, price);
      await setStatus(host, "PENDING_VERIFICATION");

      const { res, buyer } = await postTrial(host, plan.id);

      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: "EXPERT_NOT_VERIFIED" });
      expect(
        await prisma.trial.count({ where: { subscriptionPlanId: plan.id } }),
      ).toBe(0);
      expect(
        await prisma.payment.count({ where: { userId: buyer.userId } }),
      ).toBe(0);
    },
    30_000,
  );

  it("a verified expert's paid trial is held and its pay-link minted", async () => {
    const host = await seedHost();
    const plan = await seedTrialPlan(host, 50_000);

    const { res, buyer } = await postTrial(host, plan.id);

    expect(res.status).toBe(201);
    const trial = await prisma.trial.findFirstOrThrow({
      where: { subscriptionPlanId: plan.id },
      select: { status: true },
    });
    expect(trial.status).toBe("AWAITING_PAYMENT");
    expect(
      await prisma.payment.count({
        where: { userId: buyer.userId, paymentStatus: "PENDING" },
      }),
    ).toBe(1);
  }, 30_000);

  it("a 1:1 request is refused and writes nothing; a verified expert's is held", async () => {
    const refused = await postRequest(await seedHost(), "REJECTED");
    expect(refused.res.status).toBe(409);
    expect(await refused.res.json()).toMatchObject({
      code: "EXPERT_NOT_VERIFIED",
    });
    expect(
      await prisma.consultation.count({
        where: { consultationPlanId: refused.planId },
      }),
    ).toBe(0);

    const verified = await postRequest(await seedHost(), "VERIFIED");
    expect(verified.res.status).toBe(201);
    expect(
      await prisma.consultation.count({
        where: { consultationPlanId: verified.planId },
      }),
    ).toBe(1);
  }, 30_000);

  it("checkout refuses an expert rejected between pricing and the lock, and writes no payment", async () => {
    const host = await seedHost();
    await publishEveryHour(host);
    const plan = await prisma.consultationPlan.create({
      data: {
        title: "Direct consultation",
        price: BigInt(100_000),
        consultantProfileId: host.consultantProfileId,
        durationInHours: 1,
      },
    });
    const buyer = await seedBuyer();
    mockRejectAfterPricing.profileId = host.consultantProfileId;

    const outcome = await handleCheckout(
      consultationCheckout(plan.id, futureAt(5, 11), `flip-${randomUUID()}`),
      buyer.userId,
    ).then(
      () => "booked",
      (error: unknown) => error,
    );
    mockRejectAfterPricing.profileId = null;

    expect(outcome).toMatchObject({ code: "EXPERT_NOT_VERIFIED" });
    expect(
      await prisma.payment.count({ where: { userId: buyer.userId } }),
    ).toBe(0);
    expect(
      await prisma.consultation.count({
        where: { consultationPlanId: plan.id },
      }),
    ).toBe(0);
  }, 30_000);
});

describe("a moderation reject stops new sales and honours what is booked", () => {
  it("refuses the unpaid approved link and leaves the paid future session as it was", async () => {
    const host = await seedHost();
    const paidBuyer = await seedConsultee();
    const paid = await seedOneToOne(
      "consultation",
      host,
      paidBuyer,
      { startsAt: futureAt(8, 9), endsAt: futureAt(8, 10) },
      {
        status: "APPROVED",
        isTentative: false,
        payment: { status: "SUCCEEDED", expiresAt: null },
      },
    );
    const unpaidBuyer = await seedConsultee();
    const unpaid = await seedOneToOne(
      "consultation",
      host,
      unpaidBuyer,
      { startsAt: futureAt(9, 9), endsAt: futureAt(9, 10) },
      {
        status: "APPROVED_PENDING_PAYMENT",
        bookingSource: "REQUEST_SUBMITTED",
        isTentative: true,
      },
    );
    const staff = await seedConsultee();

    const effects = await prisma.$transaction((tx) =>
      applyTransactionalEffects(tx, {
        actionType: "PROFILE_UNVERIFIED",
        report: {
          id: randomUUID(),
          type: "PROFILE",
          targetUserId: host.userId,
          reviewId: null,
        },
        staffUserId: staff.userId,
      }),
    );

    const mint = await mintApprovalPaymentAfterCommit({
      kind: "consultation",
      id: unpaid.consultationId!,
    });
    expect(mint.status).toBe("mint_failed");
    expect(mint.status === "mint_failed" && mint.error).toMatchObject({
      code: "EXPERT_NOT_VERIFIED",
    });
    expect(
      await prisma.payment.count({
        where: { appointmentId: unpaid.appointmentId },
      }),
    ).toBe(0);

    expect(effects.unverifiedConsultantProfileId).toBe(
      host.consultantProfileId,
    );
    const kept = await prisma.consultation.findUniqueOrThrow({
      where: { id: paid.consultationId! },
      select: {
        status: true,
        appointment: {
          select: {
            occurrences: {
              select: { completionStatus: true, deletedAt: true },
            },
            payment: { select: { paymentStatus: true } },
          },
        },
      },
    });
    expect(kept).toEqual({
      status: "APPROVED",
      appointment: {
        occurrences: [{ completionStatus: "SCHEDULED", deletedAt: null }],
        payment: [{ paymentStatus: "SUCCEEDED" }],
      },
    });
  }, 30_000);

  it("refuses the re-mint of a rejected expert's paid trial whose order lapsed", async () => {
    const host = await seedHost();
    const plan = await seedTrialPlan(host, 50_000);
    const { res, buyer } = await postTrial(host, plan.id);
    expect(res.status).toBe(201);
    const trial = await prisma.trial.findFirstOrThrow({
      where: { subscriptionPlanId: plan.id },
      select: { id: true, appointmentId: true },
    });
    await prisma.payment.updateMany({
      where: { userId: buyer.userId },
      data: { paymentStatus: "EXPIRED" },
    });
    await setStatus(host, "REJECTED");

    const outcome = await createApprovalPaymentIntent({
      userId: buyer.userId,
      appointmentType: "TRIAL",
      trialId: trial.id,
      appointmentId: trial.appointmentId ?? undefined,
      planId: plan.id,
      paymentGateway: "RAZORPAY",
    }).then(
      () => "minted",
      (error: unknown) => error,
    );

    expect(outcome).toMatchObject({ code: "EXPERT_NOT_VERIFIED" });
    expect(
      await prisma.payment.count({
        where: { userId: buyer.userId, paymentStatus: "PENDING" },
      }),
    ).toBe(0);
  }, 30_000);
});
