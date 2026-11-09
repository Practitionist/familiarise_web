/**
 * The 30-day APPROVED-unallocated arm on real Postgres refunds in full only a
 * plan that never had a confirmed session and has no open proposal. A plan
 * that ever had one (returned, cancelled, tombstoned or released) is a
 * mid-plan straggler and waits for plan-end settlement.
 */
import prisma from "../../../lib/prisma";
import {
  HOUR_MS,
  seedConsultee,
  seedHost,
  seedPaidSubscription,
} from "./harness";
import { refundedPaise, refundOnRowsEachTest } from "./harness-refunds";

jest.mock("../../../lib/novu", () =>
  jest.requireActual("../../fixtures/noop-module").noopModule(),
);
jest.mock("../../../lib/novu/service", () =>
  jest.requireActual("../../fixtures/noop-module").noopModule(),
);

import { expireStaleRequests } from "../../../scripts/appointments/expire-stale-requests";

refundOnRowsEachTest();

const DAY_MS = 24 * HOUR_MS;

/** A paid plan approved 31 days ago with nothing live on it. */
async function seedStaleApproved() {
  const host = await seedHost();
  const subscriber = await seedConsultee();
  const sub = await seedPaidSubscription(
    host,
    subscriber,
    new Date(Date.now() - 31 * DAY_MS),
  );
  const paymentId = (
    await prisma.payment.findFirstOrThrow({
      where: { appointmentId: sub.appointmentId },
      select: { id: true },
    })
  ).id;
  const age = new Date(Date.now() - 31 * DAY_MS);
  await prisma.$executeRaw`UPDATE "Subscription" SET status = 'APPROVED', "updatedAt" = ${age} WHERE id = ${sub.subscriptionId}`;
  return { host, subscriber, ...sub, paymentId };
}

async function addRow(
  appointmentId: string,
  consultantProfileId: string,
  data: {
    isTentative: boolean;
    completionStatus: "CANCELLED" | "RESCHEDULED";
    deletedAt: Date | null;
  },
) {
  const startsAt = new Date(Date.now() - 20 * DAY_MS);
  return prisma.appointmentOccurrence.create({
    data: {
      appointmentId,
      ordinal: 1,
      startsAt,
      endsAt: new Date(startsAt.getTime() + HOUR_MS),
      consultantProfileId,
      ...data,
    },
  });
}

/** Re-ages the plan after a seed write bumped its row. */
async function age(subscriptionId: string) {
  const at = new Date(Date.now() - 31 * DAY_MS);
  await prisma.$executeRaw`UPDATE "Subscription" SET "updatedAt" = ${at} WHERE id = ${subscriptionId}`;
}

async function statusOf(subscriptionId: string) {
  return (
    await prisma.subscription.findUniqueOrThrow({
      where: { id: subscriptionId },
      select: { status: true },
    })
  ).status;
}

describe("the 30-day APPROVED-unallocated arm", () => {
  it("expires and fully refunds a plan that never had a confirmed session", async () => {
    const plan = await seedStaleApproved();

    await expireStaleRequests();

    expect(await statusOf(plan.subscriptionId)).toBe("EXPIRED");
    expect(await refundedPaise(plan.paymentId)).toBe(400_000);
  });

  it("leaves a plan whose confirmed session was returned or cancelled", async () => {
    const plan = await seedStaleApproved();
    await addRow(plan.appointmentId, plan.host.consultantProfileId, {
      isTentative: false,
      completionStatus: "CANCELLED",
      deletedAt: new Date(Date.now() - 10 * DAY_MS),
    });
    await age(plan.subscriptionId);

    await expireStaleRequests();

    expect(await statusOf(plan.subscriptionId)).toBe("APPROVED");
    expect(await refundedPaise(plan.paymentId)).toBe(0);
  });

  it("leaves a plan whose released session went back to the plan", async () => {
    const plan = await seedStaleApproved();
    const row = await addRow(
      plan.appointmentId,
      plan.host.consultantProfileId,
      {
        isTentative: true,
        completionStatus: "CANCELLED",
        deletedAt: new Date(Date.now() - 2 * DAY_MS),
      },
    );
    await prisma.rescheduleRequest.create({
      data: {
        appointmentId: plan.appointmentId,
        initiatorRole: "CONSULTEE",
        initiatedById: plan.subscriber.userId,
        status: "DECLINED",
        releasedOccurrenceIds: [row.id],
        expiresAt: new Date(Date.now() - 25 * DAY_MS),
        resolvedAt: new Date(Date.now() - 25 * DAY_MS),
      },
    });
    await age(plan.subscriptionId);

    await expireStaleRequests();

    expect(await statusOf(plan.subscriptionId)).toBe("APPROVED");
    expect(await refundedPaise(plan.paymentId)).toBe(0);
  });

  it("leaves a plan with an open proposal", async () => {
    const plan = await seedStaleApproved();
    await prisma.rescheduleRequest.create({
      data: {
        appointmentId: plan.appointmentId,
        initiatorRole: "CONSULTANT",
        initiatedById: plan.host.userId,
        status: "PENDING_REVIEW",
        releasedOccurrenceIds: [],
        expiresAt: new Date(Date.now() + DAY_MS),
        openForAppointmentId: plan.appointmentId,
      },
    });
    await age(plan.subscriptionId);

    await expireStaleRequests();

    expect(await statusOf(plan.subscriptionId)).toBe("APPROVED");
    expect(await refundedPaise(plan.paymentId)).toBe(0);
  });
});
