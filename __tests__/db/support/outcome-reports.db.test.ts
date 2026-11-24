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
import { runSupportTurn } from "../../../lib/support/service";
import { releaseEarningsFromHold } from "../../../scripts/earnings/release-earnings";

/** A paid consultation whose call is live now: the learner holds a seat, the host's 80,000-paise earning waits. */
async function seedLiveConsultation() {
  const host = await seedHost();
  const learner = await seedConsultee();
  const booking = await seedOneToOne(
    "consultation",
    host,
    learner,
    {
      startsAt: new Date(Date.now() - 0.5 * HOUR_MS),
      endsAt: new Date(Date.now() + 0.5 * HOUR_MS),
    },
    {
      status: "APPROVED",
      isTentative: false,
      payment: { status: "SUCCEEDED", amount: 100_000, expiresAt: null },
    },
  );
  const earning = await prisma.consultantEarnings.create({
    data: {
      consultantProfileId: host.consultantProfileId,
      paymentId: booking.payment!.id,
      grossAmount: BigInt(100_000),
      platformFeePaise: BigInt(20_000),
      consultantSharePaise: BigInt(80_000),
      cycleOrdinal: 0,
      status: "PENDING",
      holdUntil: new Date(Date.now() - HOUR_MS),
    },
  });
  return { host, learner, booking, earningId: earning.id };
}

/** The call ends: the host waited the hour, the learner never came, Stream's record settled, the verdict is written. */
async function endWithLearnerAbsent(
  booking: { occurrenceId: string },
  hostUserId: string,
) {
  const startsAt = new Date(Date.now() - 2 * HOUR_MS);
  const endsAt = new Date(Date.now() - HOUR_MS);
  await prisma.appointmentOccurrence.update({
    where: { id: booking.occurrenceId },
    data: {
      startsAt,
      endsAt,
      completionStatus: "COMPLETED",
      completedAt: endsAt,
      outcome: "LEARNER_ABSENT",
      outcomeAt: new Date(Date.now() - 0.5 * HOUR_MS),
    },
  });
  const meeting = await prisma.meeting.create({
    data: {
      streamCallId: `occurrence-${booking.occurrenceId}`,
      appointmentOccurrenceId: booking.occurrenceId,
      endedAt: endsAt,
      endedReason: "session_timeout",
      attendanceSettledAt: new Date(Date.now() - 0.6 * HOUR_MS),
    },
  });
  await prisma.meetingPresence.create({
    data: {
      meetingId: meeting.id,
      appointmentOccurrenceId: booking.occurrenceId,
      userId: hostUserId,
      userSessionId: `${hostUserId}-stay`,
      joinedAt: startsAt,
      leftAt: endsAt,
    },
  });
}

const earningStatus = async (id: string) =>
  (await prisma.consultantEarnings.findUniqueOrThrow({ where: { id } })).status;

it("keeps the host's earning PENDING when the learner disputes after a call that was live when they first asked", async () => {
  const live = await seedLiveConsultation();
  const { booking, learner, host } = live;
  // While the call is live no session has ended, so no report opens and nothing is booking-wide.
  await expect(
    runSupportTurn(booking.appointmentId, learner.userId, {
      category: "NO_SHOW",
    }),
  ).rejects.toMatchObject({ body: { code: "SESSION_REQUIRED" } });
  expect(
    await prisma.supportCase.count({
      where: { requesterUserId: learner.userId, category: "NO_SHOW" },
    }),
  ).toBe(0);

  await endWithLearnerAbsent(booking, host.userId);
  const opened = await runSupportTurn(booking.appointmentId, learner.userId, {
    category: "NO_SHOW",
  });
  await runSupportTurn(booking.appointmentId, learner.userId, {
    chosenOptionId: "attended",
    caseId: opened?.threadId,
    appointmentOccurrenceId: opened?.appointmentOccurrenceId ?? undefined,
  });
  expect(
    await prisma.supportCase.findUniqueOrThrow({
      where: { id: opened!.threadId },
    }),
  ).toMatchObject({
    appointmentOccurrenceId: booking.occurrenceId,
    flowReason: "attendee_attended",
  });

  // A control booking with the same strong evidence and no report is confirmed, so the evidence is strong.
  const control = await seedLiveConsultation();
  await endWithLearnerAbsent(control.booking, control.host.userId);

  const afterWindow = new Date(Date.now() + 49 * HOUR_MS);
  const run = await confirmClosedOutcomes(afterWindow, () => false);
  expect(run.errors).toEqual([]);
  const confirmed = async (id: string) =>
    (await prisma.appointmentOccurrence.findUniqueOrThrow({ where: { id } }))
      .outcomeConfirmedAt;
  expect(await confirmed(booking.occurrenceId)).toBeNull();
  expect(await confirmed(control.booking.occurrenceId)).not.toBeNull();

  await releaseEarningsFromHold();
  expect(await earningStatus(live.earningId)).toBe("PENDING");
  expect(await earningStatus(control.earningId)).toBe("READY");
});

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
