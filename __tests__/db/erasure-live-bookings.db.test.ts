/**
 * What blocks an erasure, read on real Postgres: a learner's paid seat on a
 * class or webinar counts from purchase until its last session ends, and an
 * expert's open bookings count even when no money is in flight.
 */
import prisma from "../../lib/prisma";
import {
  hostedBookingsForUser,
  liveBookingsForUser,
} from "../../lib/compliance/erasure/scrub-user";
import { HOUR_MS, seedConsultee, seedHost } from "./booking/harness";
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
