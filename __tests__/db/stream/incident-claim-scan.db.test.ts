/**
 * The incident job's claim report reaches an older incident on real Postgres:
 * with 21 incidents in the review period and only the oldest holding an
 * unreported no-show claim, one run reports it, however many newer ones exist.
 */
import prisma from "../../../lib/prisma";
import { settlePlatformIncidents } from "../../../scripts/appointments/settle-platform-incidents";
import { seedConsultee, seedHost, seedOneToOne } from "../booking/harness";

jest.mock("../../../lib/novu", () =>
  jest.requireActual("../../fixtures/noop-module").noopModule(),
);

const DAY_MS = 24 * 3_600_000;
const MIN_MS = 60_000;

/** A consultation session a confirmed no-show claim cancelled, `daysAgo` days back at an odd minute. */
async function seedClaimedSession(daysAgo: number) {
  const startsAt = new Date(Date.now() - daysAgo * DAY_MS);
  startsAt.setUTCSeconds(0, 0);
  startsAt.setUTCMinutes(17);
  const endsAt = new Date(startsAt.getTime() + 60 * MIN_MS);
  const booking = await seedOneToOne(
    "consultation",
    await seedHost(),
    await seedConsultee(),
    { startsAt, endsAt },
    { status: "CANCELLED", isTentative: false, completionStatus: "CANCELLED" },
  );
  await prisma.appointmentOccurrence.update({
    where: { id: booking.occurrenceId },
    data: {
      deletedAt: new Date(endsAt.getTime() + 3 * DAY_MS),
      outcome: "HOST_ABSENT",
      outcomeAt: new Date(endsAt.getTime() + DAY_MS),
      outcomeConfirmedAt: new Date(endsAt.getTime() + 3 * DAY_MS),
    },
  });
  return { ...booking, startsAt, endsAt };
}

/** An incident already enumerated and settled, so the run only reports its claims. */
const closedIncident = (startsAt: Date, endsAt: Date) =>
  prisma.platformIncident.create({
    data: {
      startsAt,
      endsAt,
      reason: "Database tier incident",
      enumeratedAt: endsAt,
      reportedAt: endsAt,
      settledAt: endsAt,
    },
    select: { id: true },
  });

it("reports the only unreported claim, on the oldest of 21 recent incidents, in one run", async () => {
  const claim = await seedClaimedSession(25);
  const ids: string[] = [];
  try {
    ids.push((await closedIncident(claim.startsAt, claim.endsAt)).id);
    // Twenty newer incidents, a few minutes each, over no session.
    for (let d = 1; d <= 20; d++) {
      const at = new Date(Date.now() - d * DAY_MS);
      at.setUTCMinutes(41, 0, 0);
      ids.push(
        (await closedIncident(at, new Date(at.getTime() + 3 * MIN_MS))).id,
      );
    }

    await settlePlatformIncidents();

    expect(
      await prisma.systemEvent.count({
        where: {
          correlationId: `incident-no-show-claim:${ids[0]}:${claim.occurrenceId}`,
        },
      }),
    ).toBe(1);
  } finally {
    await prisma.platformIncident.deleteMany({ where: { id: { in: ids } } });
  }
});
