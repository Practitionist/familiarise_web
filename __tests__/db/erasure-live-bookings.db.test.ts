/**
 * What blocks an erasure, read on real Postgres: a learner's paid seat on a
 * class or webinar counts from purchase until its last session ends, an
 * expert's open bookings count even when no money is in flight, and a session
 * the expert hosts or co-hosts counts until it ends.
 */
import prisma from "../../lib/prisma";
import {
  hostedBookingsForUser,
  liveBookingsForUser,
} from "../../lib/compliance/erasure/scrub-user";
import { HOUR_MS, seedConsultee, seedHost } from "./booking/harness";
import { seedClassUnderWay } from "./booking/harness-class-series";
import { seedHeldSeat, seedWebinar } from "./booking/harness-seats";

/** A paid, confirmed seat on a one-hour webinar that starts `startsInMs` from now. */
async function seatOnWebinar(startsInMs: number) {
  const webinar = await seedWebinar({
    capacity: 10,
    startsAt: new Date(Date.now() + startsInMs),
  });
  const { buyer } = await seedHeldSeat(webinar, {
    status: "SUCCEEDED",
    expiresAt: null,
  });
  return buyer.userId;
}

const seatsOf = async (userId: string) =>
  (await liveBookingsForUser(prisma, userId)).activeEventSeats;

describe("a learner's class or webinar seat and erasure", () => {
  it("blocks while the webinar is still ahead", async () => {
    expect(await seatsOf(await seatOnWebinar(48 * HOUR_MS))).toBe(1);
  });

  it("still blocks half an hour into the session", async () => {
    expect(await seatsOf(await seatOnWebinar(-HOUR_MS / 2))).toBe(1);
  });

  it("stops blocking once the session has ended", async () => {
    expect(await seatsOf(await seatOnWebinar(-3 * HOUR_MS))).toBe(0);
  });
});

describe("an expert's hosted bookings and erasure", () => {
  it("counts a scheduled free trial the expert hosts", async () => {
    const host = await seedHost();
    const buyer = await seedConsultee();
    const plan = await prisma.subscriptionPlan.create({
      data: {
        title: "Free trial plan",
        price: BigInt(100_000),
        consultantProfileId: host.consultantProfileId,
      },
    });
    await prisma.trial.create({
      data: {
        consulteeProfileId: buyer.consulteeProfileId,
        consultantProfileId: host.consultantProfileId,
        subscriptionPlanId: plan.id,
        status: "SCHEDULED",
      },
    });

    const hosted = await hostedBookingsForUser(prisma, host.userId);

    expect(hosted?.hasActive).toBe(true);
    expect(hosted?.breakdown.trials).toBe(1);
    // The learner side of the same trial blocks the learner, not the expert.
    expect((await liveBookingsForUser(prisma, host.userId)).activeTrials).toBe(
      0,
    );
    expect((await liveBookingsForUser(prisma, buyer.userId)).activeTrials).toBe(
      1,
    );
  });

  it("answers null for a user with no expert profile", async () => {
    const buyer = await seedConsultee();

    expect(await hostedBookingsForUser(prisma, buyer.userId)).toBeNull();
  });
});

describe("a session the expert hosts or co-hosts and erasure", () => {
  /** An accepted co-host of the plan, as the invitation's accept leaves the row. */
  async function acceptedCoHost(
    plan: { webinarPlanId: string } | { classPlanId: string },
  ) {
    const cohost = await seedHost();
    const isWebinar = "webinarPlanId" in plan;
    const invite = await prisma.collaborator.create({
      data: {
        ...plan,
        consultantProfileId: cohost.consultantProfileId,
        collaboratorType: isWebinar ? "WEBINAR" : "CLASS",
        role: isWebinar ? "CO_HOST" : "CO_INSTRUCTOR",
        tier: "PRESENTER",
        revenueShareBps: 1_000,
      },
    });
    await prisma.collaborator.update({
      where: { id: invite.id },
      data: { status: "ACCEPTED" },
    });
    return cohost;
  }

  const blockOf = async (userId: string) => {
    const hosted = await hostedBookingsForUser(prisma, userId);
    return {
      hasActive: hosted?.hasActive,
      underWay: hosted?.breakdown.sessionsUnderWay,
    };
  };

  it("blocks the webinar's host and its accepted co-host half an hour into the session", async () => {
    const webinar = await seedWebinar({
      capacity: 10,
      startsAt: new Date(Date.now() - HOUR_MS / 2),
    });
    const cohost = await acceptedCoHost({ webinarPlanId: webinar.planId });

    expect(await blockOf(webinar.host.userId)).toEqual({
      hasActive: true,
      underWay: 1,
    });
    expect(await blockOf(cohost.userId)).toEqual({
      hasActive: true,
      underWay: 1,
    });
  });

  it("stops blocking both once the webinar's session has ended", async () => {
    const webinar = await seedWebinar({
      capacity: 10,
      startsAt: new Date(Date.now() - 3 * HOUR_MS),
    });
    const cohost = await acceptedCoHost({ webinarPlanId: webinar.planId });

    expect(await blockOf(webinar.host.userId)).toEqual({
      hasActive: false,
      underWay: 0,
    });
    expect(await blockOf(cohost.userId)).toEqual({
      hasActive: false,
      underWay: 0,
    });
  });

  it("counts a webinar that starts at the very instant of the check once for its host and once for its co-host", async () => {
    const webinar = await seedWebinar({ capacity: 10 });
    const cohost = await acceptedCoHost({ webinarPlanId: webinar.planId });

    const asHost = await hostedBookingsForUser(
      prisma,
      webinar.host.userId,
      webinar.startsAt,
    );
    const asCoHost = await hostedBookingsForUser(
      prisma,
      cohost.userId,
      webinar.startsAt,
    );

    expect(asHost?.total).toBe(1);
    expect(asHost?.breakdown).toMatchObject({
      webinars: 1,
      sessionsUnderWay: 0,
    });
    expect(asCoHost?.total).toBe(1);
    expect(asCoHost?.breakdown).toMatchObject({
      collaborations: 0,
      sessionsUnderWay: 1,
    });
  });

  it("blocks a class's accepted co-host during its last session", async () => {
    const host = await seedHost();
    const cls = await seedClassUnderWay(host, {
      price: 10_000,
      sessions: 1,
      delivered: 0,
    });
    const startsAt = new Date(Date.now() - HOUR_MS / 2);
    await prisma.appointmentOccurrence.update({
      where: { id: cls.occurrenceIds[0] },
      data: { startsAt, endsAt: new Date(startsAt.getTime() + HOUR_MS) },
    });
    const { classPlanId } = await prisma.class.findUniqueOrThrow({
      where: { id: cls.classId },
      select: { classPlanId: true },
    });
    const cohost = await acceptedCoHost({ classPlanId });

    expect(await blockOf(cohost.userId)).toEqual({
      hasActive: true,
      underWay: 1,
    });
  });
});
