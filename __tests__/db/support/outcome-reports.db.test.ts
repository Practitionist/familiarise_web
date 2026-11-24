/** A no-show report on a negative verdict, through the window-close pass and the needs-human read on real Postgres. */
import prisma from "../../../lib/prisma";
import { createOrReuseSupportCase } from "../../../lib/support/case-service";
import { confirmClosedOutcomes } from "../../../lib/booking/session-outcome-sweep";
import { readSessionsNeedingHuman } from "../../../lib/backoffice/session-outcomes";
import {
  HOUR_MS,
  seedConsultee,
  seedHost,
  seedOneToOne,
} from "../booking/harness";
import { intakeFor } from "../seed";

it("holds a closed verdict the expert disputed inside its window and lists it for ops with the expert's report", async () => {
  const host = await seedHost();
  const learner = await seedConsultee();
  // Long past, so the row leads the list's oldest-first page.
  const endsAt = new Date("2020-01-06T11:00:00Z");
  const booking = await seedOneToOne(
    "consultation",
    host,
    learner,
    { startsAt: new Date(endsAt.getTime() - HOUR_MS), endsAt },
    { status: "COMPLETED", isTentative: false, completionStatus: "VOIDED" },
  );
  await prisma.appointmentOccurrence.update({
    where: { id: booking.occurrenceId },
    data: {
      outcome: "HOST_ABSENT",
      // The 48-hour window closed an hour ago.
      outcomeAt: new Date(Date.now() - 49 * HOUR_MS),
      voidedAt: new Date(Date.now() - 49 * HOUR_MS),
    },
  });
  const { supportCase } = await createOrReuseSupportCase(
    intakeFor(host.userId, {
      category: "NO_SHOW",
      appointmentId: booking.appointmentId,
      appointmentOccurrenceId: booking.occurrenceId,
    }),
  );
  await prisma.supportCase.update({
    where: { id: supportCase.id },
    data: {
      flowReason: "provider_attended",
      flowReasonAt: new Date(Date.now() - 48 * HOUR_MS),
    },
  });

  const run = await confirmClosedOutcomes(new Date(), () => false);
  expect(run.errors).toEqual([]);
  expect(run.disputed).toBeGreaterThanOrEqual(1);
  const after = await prisma.appointmentOccurrence.findUniqueOrThrow({
    where: { id: booking.occurrenceId },
  });
  expect(after.outcomeConfirmedAt).toBeNull();

  const { items } = await readSessionsNeedingHuman();
  expect(items.find((i) => i.id === booking.occurrenceId)).toMatchObject({
    outcome: "HOST_ABSENT",
    reports: [
      { caseId: supportCase.id, side: "HOST", reason: "provider_attended" },
    ],
  });
});
