/**
 * The expert cancels a confirmed paid trial through trial DELETE on real
 * Postgres: the trial is CANCELLED and its session tombstoned, the payment
 * carries the refund-owed marker for the full amount under
 * `trial-cancel:<trial>:<payment>` from the same commit, the refund door is
 * driven for that amount, and one expert-reliability strike is written.
 */
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import prisma from "../../../lib/prisma";
import { transitionTrial } from "../../../lib/booking/transitions";
import { bookTrialInTx } from "../../../lib/trials/book-trial";
import { futureAt, seedHost } from "./harness";
import { publishEveryHour, seedBuyer } from "./harness-host";
import { refundDoor, sessionUser } from "./harness-edges";

jest.mock("../../../lib/auth-helpers", () =>
  jest.requireActual("./harness-edges").authHelpersMock(),
);
jest.mock("../../../lib/rate-limit", () =>
  jest.requireActual("./harness-edges").rateLimitMock(),
);
jest.mock("../../../lib/novu/stage-then-attempt", () =>
  jest.requireActual("./harness-edges").noFlushMock(),
);
jest.mock("../../../lib/novu", () =>
  jest.requireActual("../../fixtures/noop-module").noopModule(),
);

import { DELETE } from "../../../app/api/trials/[trialId]/route";

const PRICE = 50_000;

async function scheduledPaidTrial() {
  const host = await seedHost();
  await publishEveryHour(host);
  const buyer = await seedBuyer();
  const plan = await prisma.subscriptionPlan.create({
    data: {
      title: "Paid trial plan",
      price: BigInt(400_000),
      consultantProfileId: host.consultantProfileId,
      sessionsPerWeek: 1,
      durationInMonths: 1,
      sessionDurationInHours: 1,
      totalSessions: 4,
      trialEnabled: true,
      trialDurationMinutes: 30,
      trialPriceInPaise: BigInt(PRICE),
    },
  });
  const startsAt = futureAt(4, 10);
  const held = await prisma.$transaction((tx) =>
    bookTrialInTx(tx, {
      consulteeProfileId: buyer.consulteeProfileId,
      consultantProfileId: host.consultantProfileId,
      subscriptionPlanId: plan.id,
      organizationId: null,
      consulteeUserId: buyer.userId,
      consultantUserId: host.userId,
      paid: true,
      pricePaise: 49_900,
      sessionMinutes: 30,
      startsAt,
      endsAt: new Date(startsAt.getTime() + 30 * 60_000),
    }),
  );
  const payment = await prisma.payment.create({
    data: {
      amount: BigInt(PRICE),
      originalAmount: BigInt(PRICE),
      paymentMethod: "card",
      paymentIntent: `order_dbtier_${randomUUID()}`,
      paymentGateway: "RAZORPAY",
      paymentStatus: "SUCCEEDED",
      userId: buyer.userId,
      appointmentId: held.appointmentId,
      isMockPayment: true,
      legs: { create: [{ source: "CARD", amountPaise: BigInt(PRICE) }] },
    },
  });
  // The capture's own writes: SCHEDULED with the payment, the hold confirmed.
  await prisma.$transaction(async (tx) => {
    await transitionTrial(tx, {
      where: { id: held.id },
      to: "SCHEDULED",
      fromIn: ["AWAITING_PAYMENT"],
      data: { paymentId: payment.id, paymentDueAt: null },
    });
    await tx.appointmentOccurrence.updateMany({
      where: { appointmentId: held.appointmentId },
      data: { isTentative: false },
    });
  });
  return { host, buyer, trialId: held.id, payment };
}

describe("expert cancels a paid trial", () => {
  it("refunds the full price under the trial-cancel key and records one strike", async () => {
    const { host, trialId, payment } = await scheduledPaidTrial();
    sessionUser.current = {
      id: host.userId,
      role: "CONSULTANT",
      consultantProfileId: host.consultantProfileId,
      consulteeProfileId: null,
      name: "Expert",
    };
    refundDoor.refundBookingPayment.mockClear();

    const res = await DELETE(
      new NextRequest(`http://localhost/api/trials/${trialId}`, {
        method: "DELETE",
        body: JSON.stringify({ confirmedRefundPaise: PRICE }),
      }),
      { params: Promise.resolve({ trialId }) },
    );
    expect(res.status).toBe(200);

    const trial = await prisma.trial.findUniqueOrThrow({
      where: { id: trialId },
      include: { appointment: { include: { occurrences: true } } },
    });
    expect(trial.status).toBe("CANCELLED");
    expect(
      trial.appointment?.occurrences.every((o) => o.deletedAt !== null),
    ).toBe(true);

    const marked = await prisma.payment.findUniqueOrThrow({
      where: { id: payment.id },
      select: { refundOwedKey: true, refundOwedPaise: true },
    });
    expect(marked.refundOwedKey).toBe(`trial-cancel:${trialId}:${payment.id}`);
    expect(Number(marked.refundOwedPaise)).toBe(PRICE);
    expect(refundDoor.refundBookingPayment).toHaveBeenCalledWith(
      expect.objectContaining({ amountPaise: PRICE }),
    );

    const strikes = await prisma.systemEvent.count({
      where: {
        correlationId: `expert-reliability:${host.consultantProfileId}`,
      },
    });
    expect(strikes).toBe(1);
  });
});
