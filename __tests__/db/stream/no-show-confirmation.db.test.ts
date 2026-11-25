/**
 * A consultant no-show on real Postgres: the detector only proposes it; the
 * window-close pass claims it on strong evidence (at the close, or early on the
 * learner's agreement), cancelling, refunding once and striking once in one
 * claim, and a consultant's dispute leaves no refund and no strike.
 */
import prisma from "../../../lib/prisma";
import { confirmClosedOutcomes } from "../../../lib/booking/session-outcome-sweep";
import {
  claimNoShowTx,
  readNoShowClaim,
} from "../../../lib/booking/consultant-no-show";
import { IllegalTransitionError } from "../../../lib/enterprise/transitions";
import { overturnSessionOutcome } from "../../../lib/backoffice/session-outcomes";
import { detectConsultantNoShows } from "../../../scripts/appointments/detect-consultant-no-shows";
import { createOrReuseSupportCase } from "../../../lib/support/case-service";
import { intakeFor } from "../seed";
import { refundOnRowsEachTest } from "../booking/harness-refunds";
import { fakeStream } from "./harness-stream";
import { settlePlatformIncidentForOne } from "../../../scripts/appointments/settle-platform-incidents";
import { readRefundNeedsHuman } from "../../../lib/backoffice/needs-human";
import {
  HOUR,
  lockWaiters,
  MIN,
  type Room,
  seedConsultationRoom,
  stay,
  waitFor,
} from "./harness-rooms";

jest.mock(
  "../../../lib/stream-client",
  () => jest.requireActual("./harness-stream").fakeStreamClient,
);
jest.mock("../../../lib/novu", () =>
  jest.requireActual("../../fixtures/noop-module").noopModule(),
);
jest.mock("../../../lib/novu/service", () =>
  jest.requireActual("../../fixtures/noop-module").noopModule(),
);
jest.mock("../../../lib/email", () => ({
  ...jest.requireActual("../../../lib/email"),
  sendAppointmentCancelledEmail: jest.fn(async () => ({ sent: 0 })),
  sendRefundProcessedEmail: jest.fn(async () => ({ sent: 0 })),
}));

refundOnRowsEachTest();
beforeEach(() => fakeStream.reset());

/** A paid hour that ended `endedHoursAgo` ago: the learner waited it out, the consultant never came, every session announced. */
async function seedNoShow(endedHoursAgo = 7): Promise<Room> {
  const room = await seedConsultationRoom(endedHoursAgo, { paid: true });
  fakeStream.calls.set(room.streamCallId, {
    occurrenceId: room.occurrenceId,
    sessions: [
      {
        id: "S",
        live: false,
        stays: [stay(room.learnerId, room.startsAt, 0, 60 * MIN)],
      },
    ],
  });
  await prisma.meeting.update({
    where: { id: room.meetingId },
    data: { lastStreamSessionId: "S", streamReportReadySessionIds: ["S"] },
  });
  return room;
}

/** The detector's run, then the row it proposed. */
async function propose(room: Room) {
  await detectConsultantNoShows();
  return prisma.appointmentOccurrence.findUniqueOrThrow({
    where: { id: room.occurrenceId },
  });
}

/** What the booking's money and record show: status, refunds keyed to the no-show, strikes. */
async function moneyOf(room: Room) {
  const consultation = await prisma.consultation.findUniqueOrThrow({
    where: { id: room.consultationId! },
    select: {
      status: true,
      consultationPlan: { select: { consultantProfileId: true } },
    },
  });
  const refunds = (
    await prisma.refund.findMany({
      where: { paymentId: room.payment!.id },
      select: { dedupeKey: true, amountPaise: true },
    })
  ).map((r) => ({
    dedupeKey: r.dedupeKey,
    amountPaise: Number(r.amountPaise),
  }));
  const strikes = await prisma.systemEvent.count({
    where: {
      correlationId: `expert-reliability:${consultation.consultationPlan.consultantProfileId}`,
    },
  });
  const session = await prisma.appointmentOccurrence.findUniqueOrThrow({
    where: { id: room.occurrenceId },
    select: {
      completionStatus: true,
      outcomeConfirmedAt: true,
      deletedAt: true,
    },
  });
  const { refundOwedKey } = await prisma.payment.findUniqueOrThrow({
    where: { id: room.payment!.id },
    select: { refundOwedKey: true },
  });
  return {
    status: consultation.status,
    refunds,
    strikes,
    session,
    refundOwedKey,
  };
}

/** A no-show report on the session, its reason answered at `answeredAt`. */
async function report(
  room: Room,
  userId: string,
  flowReason: string,
  answeredAt: Date,
) {
  const { supportCase } = await createOrReuseSupportCase(
    intakeFor(userId, {
      category: "NO_SHOW",
      appointmentId: room.appointmentId,
      appointmentOccurrenceId: room.occurrenceId,
    }),
  );
  await prisma.supportCase.update({
    where: { id: supportCase.id },
    data: { flowReason, flowReasonAt: answeredAt },
  });
}

it("the detector proposes and moves no money; at the close the pass refunds once and strikes once, and a replay adds nothing", async () => {
  const room = await seedNoShow();
  const proposed = await propose(room);
  expect(proposed).toMatchObject({
    completionStatus: "UNVERIFIED",
    outcome: "HOST_ABSENT",
    outcomeConfirmedAt: null,
  });
  expect(await moneyOf(room)).toMatchObject({
    status: "APPROVED",
    refunds: [],
    strikes: 0,
  });

  // Inside the window nothing is claimed.
  await confirmClosedOutcomes(new Date(), () => false);
  expect((await moneyOf(room)).refunds).toEqual([]);

  const afterClose = new Date(proposed.outcomeAt!.getTime() + 49 * HOUR);
  await confirmClosedOutcomes(afterClose, () => false);
  const claimed = await moneyOf(room);
  expect(claimed).toEqual({
    status: "CANCELLED",
    refunds: [
      {
        dedupeKey: `consultant-no-show:${room.payment!.id}`,
        amountPaise: 100_000,
      },
    ],
    strikes: 1,
    session: {
      completionStatus: "CANCELLED",
      outcomeConfirmedAt: afterClose,
      deletedAt: afterClose,
    },
    refundOwedKey: null,
  });

  await confirmClosedOutcomes(
    new Date(afterClose.getTime() + HOUR),
    () => false,
  );
  expect(await moneyOf(room)).toEqual(claimed);
});

it("the learner's agreement claims a strong proposal before the window closes", async () => {
  const room = await seedNoShow();
  const proposed = await propose(room);
  await report(room, room.learnerId, "provider_no_show", new Date());

  await confirmClosedOutcomes(new Date(), () => false);

  expect(await moneyOf(room)).toMatchObject({
    status: "CANCELLED",
    refunds: [{ dedupeKey: `consultant-no-show:${room.payment!.id}` }],
    strikes: 1,
  });
  expect(proposed.outcomeAt!.getTime()).toBeGreaterThan(Date.now() - HOUR);
});

it("the consultant's dispute leaves no refund and no strike, even after the window closes", async () => {
  const room = await seedNoShow();
  const proposed = await propose(room);
  await report(room, room.hostId, "provider_attended", new Date());

  await confirmClosedOutcomes(
    new Date(proposed.outcomeAt!.getTime() + 49 * HOUR),
    () => false,
  );

  expect(await moneyOf(room)).toMatchObject({
    status: "APPROVED",
    refunds: [],
    strikes: 0,
    session: { completionStatus: "UNVERIFIED", outcomeConfirmedAt: null },
  });
});

it("a sibling session parked as nobody joined vetoes the claim in its compare-and-set and at the pass's read: nothing is cancelled, refunded or struck", async () => {
  const room = await seedNoShow(11);
  const proposed = await propose(room);
  // Read while every session is expert-absent; the sibling is parked before the claim writes.
  const claim = await readNoShowClaim(prisma, room.occurrenceId);
  expect(claim).not.toBeNull();
  await prisma.appointmentOccurrence.create({
    data: {
      appointmentId: room.appointmentId,
      ordinal: 2,
      startsAt: new Date(room.startsAt.getTime() - 24 * HOUR),
      endsAt: new Date(room.endsAt.getTime() - 24 * HOUR),
      isTentative: false,
      consultantProfileId: proposed.consultantProfileId,
      completionStatus: "UNVERIFIED",
      outcome: "NOBODY_JOINED",
      outcomeAt: proposed.outcomeAt,
    },
  });
  const untouched = {
    status: "APPROVED",
    refunds: [],
    strikes: 0,
    refundOwedKey: null,
    session: { completionStatus: "UNVERIFIED", outcomeConfirmedAt: null },
  };

  await expect(
    prisma.$transaction((tx) =>
      claimNoShowTx(tx, claim!, { now: new Date(), actorUserId: null }),
    ),
  ).rejects.toBeInstanceOf(IllegalTransitionError);
  expect(await moneyOf(room)).toMatchObject(untouched);

  await confirmClosedOutcomes(
    new Date(proposed.outcomeAt!.getTime() + 49 * HOUR),
    () => false,
  );
  expect(await moneyOf(room)).toMatchObject(untouched);
});

it("ops Set outcome expert absent on a disputed proposal cancels, refunds in full once and strikes once, and voids nothing", async () => {
  const room = await seedNoShow(12);
  const proposed = await propose(room);
  // The consultant's dispute keeps the pass from ever claiming it; an operator decides.
  await report(room, room.hostId, "provider_attended", new Date());
  await confirmClosedOutcomes(
    new Date(proposed.outcomeAt!.getTime() + 49 * HOUR),
    () => false,
  );
  expect((await moneyOf(room)).status).toBe("APPROVED");

  const result = await overturnSessionOutcome({
    occurrenceId: room.occurrenceId,
    outcome: "HOST_ABSENT",
    actorUserId: room.learnerId,
  });

  expect(result.after).toEqual({
    completionStatus: "CANCELLED",
    outcome: "HOST_ABSENT",
  });
  expect(await moneyOf(room)).toMatchObject({
    status: "CANCELLED",
    refunds: [
      {
        dedupeKey: `consultant-no-show:${room.payment!.id}`,
        amountPaise: 100_000,
      },
    ],
    strikes: 1,
    session: { completionStatus: "CANCELLED" },
    refundOwedKey: null,
  });
  const { voidedAt } = await prisma.appointmentOccurrence.findUniqueOrThrow({
    where: { id: room.occurrenceId },
    select: { voidedAt: true },
  });
  expect(voidedAt).toBeNull();
});

it("ops Set outcome expert absent on an unpaid consultation is refused by name and changes nothing", async () => {
  const room = await seedConsultationRoom(13);
  await prisma.appointmentOccurrence.update({
    where: { id: room.occurrenceId },
    data: {
      completionStatus: "UNVERIFIED",
      outcome: "INCONCLUSIVE",
      outcomeAt: new Date(),
    },
  });

  await expect(
    overturnSessionOutcome({
      occurrenceId: room.occurrenceId,
      outcome: "HOST_ABSENT",
      actorUserId: room.learnerId,
    }),
  ).rejects.toMatchObject({ code: "NO_SHOW_UNPAID" });

  expect(
    await prisma.appointmentOccurrence.findUniqueOrThrow({
      where: { id: room.occurrenceId },
      select: { completionStatus: true, outcome: true, voidedAt: true },
    }),
  ).toEqual({
    completionStatus: "UNVERIFIED",
    outcome: "INCONCLUSIVE",
    voidedAt: null,
  });
});

/** A declared incident over the room's booked hour, removed with its remedies afterwards so no other suite sees it. */
const declareIncident = (room: Room) =>
  prisma.platformIncident.create({
    data: {
      startsAt: room.startsAt,
      endsAt: room.endsAt,
      reason: "Database tier incident",
    },
  });

it("a claim that waited on the consultation's lock while an incident was declared over the hour cancels, refunds and strikes nothing", async () => {
  const room = await seedNoShow(9);
  const proposed = await propose(room);
  const afterClose = new Date(proposed.outcomeAt!.getTime() + 49 * HOUR);
  let pass: Promise<unknown> | undefined;
  let incidentId: string | undefined;
  try {
    await prisma.$transaction(
      async (tx) => {
        // Something else holds the consultation while the pass judges the proposal strong.
        await tx.$executeRaw`SELECT 1 FROM "Consultation" WHERE id = ${room.consultationId} FOR UPDATE`;
        pass = confirmClosedOutcomes(afterClose, () => false);
        await waitFor(async () => (await lockWaiters()) >= 1);
        // The incident commits on another connection before the lock is released.
        incidentId = (await declareIncident(room)).id;
      },
      { timeout: 20_000 },
    );
    await pass;

    expect(await moneyOf(room)).toMatchObject({
      status: "APPROVED",
      refunds: [],
      strikes: 0,
      refundOwedKey: null,
      session: { completionStatus: "UNVERIFIED", outcomeConfirmedAt: null },
    });
  } finally {
    if (incidentId) {
      await prisma.platformIncident.delete({ where: { id: incidentId } });
    }
  }
});

it("a claim that committed after its incident was enumerated and settled is still listed for ops on a later pass", async () => {
  const room = await seedNoShow(10);
  const proposed = await propose(room);
  await confirmClosedOutcomes(
    new Date(proposed.outcomeAt!.getTime() + 49 * HOUR),
    () => false,
  );
  expect((await moneyOf(room)).status).toBe("CANCELLED");
  // The incident's pass read no claim and closed; the claim committed after that read.
  const incident = await prisma.platformIncident.update({
    where: { id: (await declareIncident(room)).id },
    data: {
      enumeratedAt: new Date(),
      reportedAt: new Date(),
      settledAt: new Date(),
    },
  });
  try {
    await settlePlatformIncidentForOne(incident.id);
    await settlePlatformIncidentForOne(incident.id);

    const events = await prisma.systemEvent.findMany({
      where: {
        correlationId: `incident-no-show-claim:${incident.id}:${room.occurrenceId}`,
      },
    });
    expect(events).toHaveLength(1);
    const items = await readRefundNeedsHuman();
    expect(
      items.filter(
        (i) =>
          i.kind === "incident-no-show-claim" &&
          i.occurrenceId === room.occurrenceId,
      ),
    ).toHaveLength(1);
  } finally {
    await prisma.platformIncident.delete({ where: { id: incident.id } });
  }
});
