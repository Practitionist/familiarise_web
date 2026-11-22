/**
 * The outcome written from a settled record on real Postgres: it is classified
 * with the room's end as it stands after the settle, and a consultant no-show
 * settled late still reaches the detector before the sweep parks it.
 */
import { randomUUID } from "node:crypto";
import prisma from "../../../lib/prisma";
import {
  decideSlotOutcome,
  OUTCOME_SLOT_SELECT,
} from "../../../lib/booking/session-outcome-sweep";
import { detectConsultantNoShows } from "../../../scripts/appointments/detect-consultant-no-shows";
import { seedConsultee, seedHost, seedOneToOne } from "../booking/harness";
import { fakeStream, type FakeStay } from "./harness-stream";

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

const MIN = 60_000;
const HOUR = 60 * MIN;

async function seedPaidConsultation(endedHoursAgo: number) {
  const host = await seedHost();
  const learner = await seedConsultee();
  const endsAt = new Date(Date.now() - endedHoursAgo * HOUR);
  endsAt.setUTCMinutes(0, 0, 0);
  const startsAt = new Date(endsAt.getTime() - HOUR);
  const booking = await seedOneToOne(
    "consultation",
    host,
    learner,
    { startsAt, endsAt },
    {
      status: "APPROVED",
      isTentative: false,
      payment: { status: "SUCCEEDED", expiresAt: null },
    },
  );
  const streamCallId = `occurrence-${booking.occurrenceId}`;
  const meeting = await prisma.meeting.create({
    data: {
      streamCallId,
      appointmentOccurrenceId: booking.occurrenceId,
      endedAt: endsAt,
      endedReason: "session_timeout",
    },
  });
  return {
    ...booking,
    startsAt,
    endsAt,
    streamCallId,
    meetingId: meeting.id,
    hostId: host.userId,
    learnerId: learner.userId,
  };
}

const stay = (userId: string, startsAt: Date, from: number, to: number) =>
  ({
    userId,
    userSessionId: `${userId}-${randomUUID()}`,
    joinedAt: new Date(startsAt.getTime() + from),
    leftAt: new Date(startsAt.getTime() + to),
  }) satisfies FakeStay;

const loadSlot = (occurrenceId: string) =>
  prisma.appointmentOccurrence.findUniqueOrThrow({
    where: { id: occurrenceId },
    select: OUTCOME_SLOT_SELECT,
  });

beforeEach(() => fakeStream.reset());

it("a host's deliberate end that lands while the sweep reads Stream is the end the outcome is judged with", async () => {
  const room = await seedPaidConsultation(3);
  // Both sides leave together at 30 minutes.
  fakeStream.calls.set(room.streamCallId, {
    occurrenceId: room.occurrenceId,
    sessions: [
      {
        id: "S",
        live: false,
        stays: [
          stay(room.hostId, room.startsAt, 0, 30 * MIN),
          stay(room.learnerId, room.startsAt, 0, 30 * MIN),
        ],
      },
    ],
  });
  await prisma.meeting.update({
    where: { id: room.meetingId },
    data: { streamReportReadySessionIds: ["S"] },
  });
  // The sweep loaded the room ended by a timeout; the host's "End for everyone" at 30 replaces it.
  const slot = await loadSlot(room.occurrenceId);
  await prisma.meeting.update({
    where: { id: room.meetingId },
    data: {
      endedAt: new Date(room.startsAt.getTime() + 30 * MIN),
      endedReason: "call_ended",
    },
  });

  const decision = await decideSlotOutcome(slot, {
    now: new Date(room.endsAt.getTime() + 75 * MIN),
    outages: [],
  });

  expect(decision).toMatchObject({
    kind: "written",
    verdict: { outcome: "CUT_SHORT", hostAttributed: true },
  });
});

it("a consultant no-show whose record settles only at the six-hour fallback is left to the detector, which refunds it", async () => {
  const room = await seedPaidConsultation(7);
  // The learner waited the hour; the consultant never came. No report was announced.
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
    data: { lastStreamSessionId: "S" },
  });

  const decision = await decideSlotOutcome(await loadSlot(room.occurrenceId), {
    now: new Date(),
    outages: [],
  });
  expect(decision).toEqual({ kind: "deferred", reason: "no-show-detector" });

  await detectConsultantNoShows();
  expect(
    await prisma.consultation.findUniqueOrThrow({
      where: { id: room.consultationId! },
      select: { status: true },
    }),
  ).toEqual({ status: "CANCELLED" });
});
