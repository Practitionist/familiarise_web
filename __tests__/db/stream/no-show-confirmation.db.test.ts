/**
 * A consultant no-show on real Postgres: the detector only proposes it; the
 * window-close pass claims it on strong evidence (at the close, or early on the
 * learner's agreement), cancelling, refunding once and striking once in one
 * claim, and a consultant's dispute leaves no refund and no strike.
 */
import prisma from "../../../lib/prisma";
import { confirmClosedOutcomes } from "../../../lib/booking/session-outcome-sweep";
import { detectConsultantNoShows } from "../../../scripts/appointments/detect-consultant-no-shows";
import { createOrReuseSupportCase } from "../../../lib/support/case-service";
import { intakeFor } from "../seed";
import { refundOnRowsEachTest } from "../booking/harness-refunds";
import { fakeStream } from "./harness-stream";
import {
  HOUR,
  MIN,
  type Room,
  seedConsultationRoom,
  stay,
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

/** A paid hour that ended 7 h ago: the learner waited it out, the consultant never came, every session announced. */
async function seedNoShow(): Promise<Room> {
  const room = await seedConsultationRoom(7, { paid: true });
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
  return { status: consultation.status, refunds, strikes, session };
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
