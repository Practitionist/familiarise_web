/**
 * A plan cut short by a session-count refund still pays its expert for every
 * session delivered, on real Postgres: once the sessions the buyer kept are
 * all delivered, completion stamps every tranche left, including the retained
 * part of the one the refund cut short, so none is stranded unreleasable.
 */
import prisma from "../../../lib/prisma";
import { HOUR_MS, seedConsultee, seedHost } from "./harness";
import { seedCardPayment } from "./harness-plans";

// @react-email/render needs --experimental-vm-modules under Jest; the static markup is the same tree.
jest.mock("../../../lib/email/render", () => {
  const { renderToStaticMarkup } =
    jest.requireActual<typeof import("react-dom/server")>("react-dom/server");
  return {
    renderEmail: async (element: import("react").ReactElement) => {
      const html = renderToStaticMarkup(element);
      return { html, text: html };
    },
  };
});
jest.mock("../../../lib/novu", () =>
  jest.requireActual("../../fixtures/noop-module").noopModule(),
);
jest.mock("../../../lib/novu/service", () =>
  jest.requireActual("../../fixtures/noop-module").noopModule(),
);
jest.mock("../../../lib/novu/stage-then-attempt", () =>
  jest.requireActual("./harness-edges").noFlushMock(),
);
jest.mock("../../../lib/stream/access-revocation", () =>
  jest.requireActual("./harness-edges").chatRevocationMock(),
);

import { autoCompleteAppointments } from "../../../scripts/appointments/auto-complete-appointments";

const DAY_MS = 24 * HOUR_MS;
const PRICE = 120_000;

/** 12 sessions at 4 a week (tranches of 4, 4, 4), 2 refunded, 10 delivered. */
async function seedRefundedPlan() {
  const host = await seedHost();
  const buyer = await seedConsultee();
  const now = Date.now();
  const plan = await prisma.subscriptionPlan.create({
    data: {
      title: "Intensive",
      price: BigInt(PRICE),
      totalSessions: 12,
      sessionsPerWeek: 4,
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
      sessionsTotal: 12,
      sessionsPerWeek: 4,
      sessionMinutes: 60,
      sessionsRefunded: 2,
      schedulingPeriodStartsAt: new Date(now - 25 * DAY_MS),
      schedulingPeriodEndsAt: new Date(now - 18 * DAY_MS),
      planEndsAt: new Date(now + 5 * DAY_MS),
      schedulingTimezone: "UTC",
    },
  });
  const appointment = await prisma.appointment.create({
    data: { appointmentType: "SUBSCRIPTION", subscriptionId: subscription.id },
  });
  for (let i = 0; i < 10; i++) {
    const startsAt = new Date(now - (11 - i) * DAY_MS - 3 * HOUR_MS);
    await prisma.appointmentOccurrence.create({
      data: {
        appointmentId: appointment.id,
        ordinal: i + 1,
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
  for (const cycleOrdinal of [0, 1, 2]) {
    await prisma.consultantEarnings.create({
      data: {
        consultantProfileId: host.consultantProfileId,
        paymentId: payment.id,
        grossAmount: BigInt(PRICE / 3),
        platformFeePaise: BigInt(8_000),
        consultantSharePaise: BigInt(32_000),
        cycleOrdinal,
        status: "PENDING",
        holdUntil: null,
      },
    });
  }
  return { subscriptionId: subscription.id, paymentId: payment.id };
}

it("completion stamps every tranche once the sessions the buyer kept are delivered", async () => {
  const plan = await seedRefundedPlan();

  await autoCompleteAppointments();

  const sub = await prisma.subscription.findUniqueOrThrow({
    where: { id: plan.subscriptionId },
  });
  expect(sub.status).toBe("COMPLETED");
  const tranches = await prisma.consultantEarnings.findMany({
    where: { paymentId: plan.paymentId },
    orderBy: { cycleOrdinal: "asc" },
    select: { cycleOrdinal: true, holdUntil: true },
  });
  expect(tranches.map((t) => t.cycleOrdinal)).toEqual([0, 1, 2]);
  for (const t of tranches) expect(t.holdUntil).toBeInstanceOf(Date);
});
