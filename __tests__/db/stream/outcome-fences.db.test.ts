/**
 * The outcome written from a settled record on real Postgres: it is classified
 * with the room's end as it stands after the settle, an end that commits while
 * the write waits leaves the session for a fresh decision, and a consultant
 * no-show settled late still reaches the detector before the sweep parks it.
 */
import prisma from "../../../lib/prisma";
import { decideSlotOutcome } from "../../../lib/booking/session-outcome-sweep";
import { rereadSessionAttendance } from "../../../lib/backoffice/session-outcomes";
import { detectConsultantNoShows } from "../../../scripts/appointments/detect-consultant-no-shows";
import { ATTENDANCE_SETTLE_DELAY_MS } from "../../../lib/meetings/settle-attendance";
import { fakeStream } from "./harness-stream";
import {
  loadSlot,
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

const seedPaidConsultation = (endedHoursAgo: number) =>
  seedConsultationRoom(endedHoursAgo, { paid: true });
/** The first slot pass after Stream's record becomes readable. */
const READ_AT = ATTENDANCE_SETTLE_DELAY_MS + 15 * MIN;

/**
 * Both sides leave together at 30 minutes and Stream times the session out
 * then; the report is announced. `listedFor` files the call under another
 * occurrence, so the read must fetch the room's call by id.
 */
async function stageHalfHourTimeout(
  room: Room,
  listedFor: string = room.occurrenceId,
) {
  fakeStream.calls.set(room.streamCallId, {
    occurrenceId: listedFor,
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
    data: {
      endedAt: new Date(room.startsAt.getTime() + 30 * MIN),
      endedReason: "session_timeout",
      streamReportReadySessionIds: ["S"],
    },
  });
}

beforeEach(() => fakeStream.reset());

it("a host's deliberate end that lands while the sweep reads Stream is the end the outcome is judged with", async () => {
  const room = await seedPaidConsultation(3);
  await stageHalfHourTimeout(room);
  // The sweep loaded the room ended by a timeout; the host's "End for everyone" at 30 replaces it.
  const slot = await loadSlot(room.occurrenceId);
  await prisma.meeting.update({
    where: { id: room.meetingId },
    data: { endedReason: "call_ended" },
  });

  const decision = await decideSlotOutcome(slot, {
    now: new Date(room.endsAt.getTime() + READ_AT),
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

it("a host's deliberate end that commits while the outcome write waits on the session leaves it SCHEDULED for a fresh decision", async () => {
  const room = await seedPaidConsultation(3);
  await stageHalfHourTimeout(room);
  const slot = await loadSlot(room.occurrenceId);
  let write: Promise<unknown> | undefined;
  await prisma.$transaction(
    async (tx) => {
      // Something else holds the session row while the sweep classifies a timeout.
      await tx.$executeRaw`SELECT 1 FROM "AppointmentOccurrence" WHERE id = ${room.occurrenceId} FOR NO KEY UPDATE`;
      write = decideSlotOutcome(slot, {
        now: new Date(room.endsAt.getTime() + READ_AT),
        outages: [],
      });
      await waitFor(async () => (await lockWaiters()) >= 1);
      // The host's "End for everyone" at the same moment commits on another connection.
      await prisma.meeting.update({
        where: { id: room.meetingId },
        data: { endedReason: "call_ended" },
      });
    },
    { timeout: 20_000 },
  );
  await write;

  expect(
    await prisma.appointmentOccurrence.findUniqueOrThrow({
      where: { id: room.occurrenceId },
      select: { completionStatus: true, outcome: true },
    }),
  ).toEqual({ completionStatus: "SCHEDULED", outcome: null });
});

it("a learner's announced device check never settles a consultant no-show early; at the six-hour fallback the detector refunds it", async () => {
  const room = await seedPaidConsultation(7);
  // A: the learner's device check before the start, announced. B: the hour the learner waited, not yet in stats.
  const sessionB = {
    id: "B",
    live: false,
    hiddenFromStats: true,
    stays: [stay(room.learnerId, room.startsAt, 0, 60 * MIN)],
  };
  fakeStream.calls.set(room.streamCallId, {
    occurrenceId: room.occurrenceId,
    sessions: [
      {
        id: "A",
        live: false,
        stays: [stay(room.learnerId, room.startsAt, -12 * MIN, -10 * MIN)],
      },
      sessionB,
    ],
  });
  await prisma.meeting.update({
    where: { id: room.meetingId },
    data: { streamReportReadySessionIds: ["A"], lastStreamSessionId: "A" },
  });

  expect(
    await decideSlotOutcome(await loadSlot(room.occurrenceId), {
      now: new Date(room.endsAt.getTime() + 75 * MIN),
      outages: [],
    }),
  ).toEqual({ kind: "deferred", reason: "attendance-unsettled" });

  sessionB.hiddenFromStats = false;
  expect(
    await decideSlotOutcome(await loadSlot(room.occurrenceId), {
      now: new Date(),
      outages: [],
    }),
  ).toEqual({ kind: "deferred", reason: "no-show-detector" });

  await detectConsultantNoShows();
  expect(
    await prisma.consultation.findUniqueOrThrow({
      where: { id: room.consultationId! },
      select: { status: true },
    }),
  ).toEqual({ status: "CANCELLED" });
});

it("the ops re-read names the verdict with the end a host's webhook committed during its Stream read", async () => {
  const room = await seedConsultationRoom(80);
  // The occurrence listing misses the room's call, so the read waits on call.get() for it.
  await stageHalfHourTimeout(room, "listed-under-another-occurrence");
  let release = () => {};
  fakeStream.getGate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const reread = rereadSessionAttendance({ occurrenceId: room.occurrenceId });
  await waitFor(async () => fakeStream.gets >= 1);
  // The host's "End for everyone" at 30 minutes commits while Stream is being read.
  await prisma.meeting.update({
    where: { id: room.meetingId },
    data: { endedReason: "call_ended" },
  });
  release();

  expect(await reread).toMatchObject({
    result: "settled",
    verdict: { outcome: "CUT_SHORT" },
  });
});
