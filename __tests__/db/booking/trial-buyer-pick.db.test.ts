/**
 * The buyer's trial pick against real Postgres: two buyers racing for the
 * same free trial time end with one confirmed session (the overlap
 * constraint is the backstop under the slot atoms); a paid hold occupies its
 * time for everyone else until it is paid or lapses; and the capture confirms
 * the hold in place.
 */
import prisma from "../../../lib/prisma";
import { transitionTrial } from "../../../lib/booking/transitions";
import { isExclusionViolation } from "../../../lib/db/pg-errors";
import {
  bookTrialInTx,
  TrialTimeRefusedError,
} from "../../../lib/trials/book-trial";
import { futureAt, seedHost, type SeededHost } from "./harness";
import { publishEveryHour, seedBuyer } from "./harness-host";

jest.mock("../../../lib/novu", () => {
  const noop = jest.fn(async () => []);
  return new Proxy(
    {},
    { get: (_target, prop) => (prop === "__esModule" ? true : noop) },
  );
});

import { confirmExistingAppointment } from "../../../lib/payments/webhooks/handlers";

async function seedTrialPlan(host: SeededHost, trialPriceInPaise: number) {
  return prisma.subscriptionPlan.create({
    data: {
      title: "Trial pick plan",
      price: BigInt(400_000),
      consultantProfileId: host.consultantProfileId,
      sessionsPerWeek: 1,
      durationInMonths: 1,
      sessionDurationInHours: 1,
      totalSessions: 4,
      trialEnabled: true,
      trialDurationMinutes: 30,
      trialPriceInPaise: BigInt(trialPriceInPaise),
    },
  });
}

async function pick(
  host: SeededHost,
  plan: { id: string },
  buyer: { userId: string; consulteeProfileId: string },
  startsAt: Date,
  paid: boolean,
) {
  return prisma.$transaction((tx) =>
    bookTrialInTx(tx, {
      consulteeProfileId: buyer.consulteeProfileId,
      consultantProfileId: host.consultantProfileId,
      subscriptionPlanId: plan.id,
      organizationId: null,
      consulteeUserId: buyer.userId,
      consultantUserId: host.userId,
      paid,
      pricePaise: paid ? 49_900 : 0,
      sessionMinutes: 30,
      startsAt,
      endsAt: new Date(startsAt.getTime() + 30 * 60_000),
    }),
  );
}

const lostTheRace = (error: unknown) =>
  isExclusionViolation(error) ||
  (error instanceof TrialTimeRefusedError && error.code === "SLOT_TAKEN");

describe("trial buyer pick", () => {
  it("two buyers racing for one free trial time: exactly one is confirmed", async () => {
    const host = await seedHost();
    await publishEveryHour(host);
    const plan = await seedTrialPlan(host, 0);
    const [a, b] = [await seedBuyer(), await seedBuyer()];
    const startsAt = futureAt(3, 10);

    const results = await Promise.allSettled([
      pick(host, plan, a, startsAt, false),
      pick(host, plan, b, startsAt, false),
    ]);
    const won = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter(
      (r): r is PromiseRejectedResult => r.status === "rejected",
    );
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(lostTheRace(lost[0].reason)).toBe(true);

    const confirmed = await prisma.appointmentOccurrence.count({
      where: {
        consultantProfileId: host.consultantProfileId,
        startsAt,
        isTentative: false,
        deletedAt: null,
      },
    });
    expect(confirmed).toBe(1);
    // The loser's trial rolled back with its session.
    expect(
      await prisma.trial.count({
        where: { consultantProfileId: host.consultantProfileId },
      }),
    ).toBe(1);
  });

  it("a paid hold occupies its time: the next buyer is refused SLOT_TAKEN", async () => {
    const host = await seedHost();
    await publishEveryHour(host);
    const plan = await seedTrialPlan(host, 50_000);
    const [a, b] = [await seedBuyer(), await seedBuyer()];
    const startsAt = futureAt(3, 12);

    const held = await pick(host, plan, a, startsAt, true);
    expect(held.status).toBe("AWAITING_PAYMENT");

    const err = await pick(host, plan, b, startsAt, true).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(TrialTimeRefusedError);
    expect((err as TrialTimeRefusedError).code).toBe("SLOT_TAKEN");
  });

  it("the capture confirms a paid hold in place: SCHEDULED, a confirmed session, CONFIRMED seats", async () => {
    const host = await seedHost();
    await publishEveryHour(host);
    const plan = await seedTrialPlan(host, 50_000);
    const buyer = await seedBuyer();
    const startsAt = futureAt(4, 9);
    const held = await pick(host, plan, buyer, startsAt, true);

    const trial = await prisma.trial.findUniqueOrThrow({
      where: { id: held.id },
      select: { paymentDueAt: true },
    });
    expect(trial.paymentDueAt).not.toBeNull();
    expect(trial.paymentDueAt!.getTime()).toBeLessThanOrEqual(
      startsAt.getTime() - 15 * 60_000,
    );

    await prisma.$transaction(async (tx) => {
      await transitionTrial(tx, {
        where: { id: held.id },
        to: "SCHEDULED",
        fromIn: ["AWAITING_PAYMENT"],
      });
      await confirmExistingAppointment(tx, held.appointmentId, buyer.userId);
    });

    const after = await prisma.trial.findUniqueOrThrow({
      where: { id: held.id },
      include: {
        appointment: { include: { occurrences: true, participants: true } },
      },
    });
    expect(after.status).toBe("SCHEDULED");
    expect(after.appointment?.occurrences).toEqual([
      expect.objectContaining({ isTentative: false, startsAt }),
    ]);
    expect(
      after.appointment?.participants.every((p) => p.status === "CONFIRMED"),
    ).toBe(true);
  });
});
