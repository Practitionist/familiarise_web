/**
 * What blocks an erasure, read on real Postgres: a learner's paid seat on a
 * class or webinar counts from purchase until its last session ends.
 */
import prisma from "../../lib/prisma";
import { liveBookingsForUser } from "../../lib/compliance/erasure/scrub-user";
import { HOUR_MS } from "./booking/harness";
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
