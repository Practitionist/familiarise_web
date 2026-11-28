/**
 * The outcome written from a settled record on real Postgres: it is classified
 * with the room's end as it stands after the settle, an end that commits while
 * the write waits leaves the session for a fresh decision, and a consultant
 * no-show settled late still reaches the detector, which proposes it.
 */
import prisma from "../../../lib/prisma";
import { decideSlotOutcome } from "../../../lib/booking/session-outcome-sweep";
import { rereadSessionAttendance } from "../../../lib/backoffice/session-outcomes";
import { recordMeetingEndedSynchronously } from "../../../lib/stream/session-handlers";
import { detectConsultantNoShows } from "../../../scripts/appointments/detect-consultant-no-shows";
import { ATTENDANCE_SETTLE_DELAY_MS } from "../../../lib/meetings/settle-attendance";
import { fakeStream } from "./harness-stream";
import { withAppointmentLock } from "../../../utils/appointmentlock";
import {
  HOUR,
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
// @react-email/render needs --experimental-vm-modules under Jest; the static markup is the same tree.
jest.mock("../../../lib/email/render", () => {
  const { renderToStaticMarkup } =
    jest.requireActual<typeof import("react-dom/server")>("react-dom/server");
  return {
    renderEmail: async (element: import("react").ReactElement) => {
      const html = renderToStaticMarkup(element);
      return { html, text: html };
    },
  };
});
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

/** The outcome the sweep stored on the occurrence. */
const storedOutcome = (occurrenceId: string) =>
  prisma.appointmentOccurrence.findUniqueOrThrow({
    where: { id: occurrenceId },
    select: { completionStatus: true, outcome: true },
  });

beforeEach(() => fakeStream.reset());

/** The detector's proposal: the session parked UNVERIFIED as HOST_ABSENT, unconfirmed, the booking still live. */
async function expectProposed(room: Room) {
  expect(
    await prisma.appointmentOccurrence.findUniqueOrThrow({
      where: { id: room.occurrenceId },
      select: {
        completionStatus: true,
        outcome: true,
        outcomeConfirmedAt: true,
      },
    }),
  ).toEqual({
    completionStatus: "UNVERIFIED",
    outcome: "HOST_ABSENT",
    outcomeConfirmedAt: null,
  });
  expect(
    await prisma.consultation.findUniqueOrThrow({
      where: { id: room.consultationId! },
      select: { status: true },
    }),
  ).toEqual({ status: "APPROVED" });
}

it("a host's deliberate end that lands after the sweep loaded the room stamps nothing that run; the next run judges with it", async () => {
  const room = await seedPaidConsultation(3);
  await stageHalfHourTimeout(room);
  // The sweep loaded the room ended by a timeout; the host's "End for everyone" at 30 replaces it.
  const slot = await loadSlot(room.occurrenceId);
  await prisma.meeting.update({
    where: { id: room.meetingId },
    data: { endedReason: "call_ended" },
  });

  const now = new Date(room.endsAt.getTime() + READ_AT);

  expect(await decideSlotOutcome(slot, { now, outages: [] })).toEqual({
    kind: "deferred",
    reason: "attendance-unsettled",
  });
  expect(
    await decideSlotOutcome(await loadSlot(room.occurrenceId), {
      now,
      outages: [],
    }),
  ).toMatchObject({
    kind: "written",
    moved: true,
    verdict: { outcome: "CUT_SHORT", hostAttributed: true },
  });
  expect(await storedOutcome(room.occurrenceId)).toEqual({
    completionStatus: "VOIDED",
    outcome: "CUT_SHORT",
  });
});

it("a void that would land while a door holds the booking's lock waits: the door's cancel commits first and the void then writes nothing", async () => {
  const room = await seedPaidConsultation(3);
  await stageHalfHourTimeout(room);
  await prisma.meeting.update({
    where: { id: room.meetingId },
    data: { endedReason: "call_ended" },
  });
  const now = new Date(room.endsAt.getTime() + READ_AT);

  // A door holds the booking's lock (a cancel between its pending-void check and its refund stamp).
  await withAppointmentLock(room.appointmentId, async () => {
    // The pass settles the record and would write the CUT_SHORT void.
    expect(
      await decideSlotOutcome(await loadSlot(room.occurrenceId), {
        now,
        outages: [],
        settleDeadlineAt: Date.now() + 5_000,
      }),
    ).toEqual({ kind: "deferred", reason: "appointment-busy" });
    expect(await storedOutcome(room.occurrenceId)).toMatchObject({
      completionStatus: "SCHEDULED",
      outcome: null,
    });
    // The door commits: the session is cancelled and tombstoned.
    await prisma.appointmentOccurrence.update({
      where: { id: room.occurrenceId },
      data: { completionStatus: "CANCELLED", deletedAt: new Date() },
    });
  });

  // The next run takes the lock and finds nothing left to void.
  expect(
    await decideSlotOutcome(await loadSlot(room.occurrenceId), {
      now,
      outages: [],
    }),
  ).toMatchObject({ kind: "written", moved: false });
  expect(await storedOutcome(room.occurrenceId)).toMatchObject({
    completionStatus: "CANCELLED",
    outcome: null,
  });
});

it("a consultant no-show whose record settles only at the six-hour fallback is left to the detector, which proposes it", async () => {
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
  await expectProposed(room);
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

it("a learner's announced device check never settles a consultant no-show early; at the six-hour fallback the detector proposes it", async () => {
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
  await expectProposed(room);
});

it("an ops re-read during which a host's end commits stores nothing; asked again, it names the verdict with that end", async () => {
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

  expect(await reread).toEqual({ result: "not-final", verdict: null });
  fakeStream.getGate = null;
  expect(
    await rereadSessionAttendance({ occurrenceId: room.occurrenceId }),
  ).toMatchObject({ result: "settled", verdict: { outcome: "CUT_SHORT" } });
});

it("an eight-hour consultation that overran to just before its booked end plus six hours is not read until six hours after the host's end; then it is HELD", async () => {
  const room = await seedConsultationRoom(30, { paid: true, hours: 8 });
  const s = room.startsAt;
  // A: the host alone for 11 minutes, announced. B: both from hour 6 to 13:56, none of its webhooks seen and not yet in stats.
  const sessionB = {
    id: "B",
    live: false,
    hiddenFromStats: true,
    stays: [
      stay(room.hostId, s, 6 * HOUR, 13 * HOUR + 56 * MIN),
      stay(room.learnerId, s, 6 * HOUR, 13 * HOUR + 56 * MIN),
    ],
  };
  fakeStream.calls.set(room.streamCallId, {
    occurrenceId: room.occurrenceId,
    sessions: [
      { id: "A", live: false, stays: [stay(room.hostId, s, 0, 11 * MIN)] },
      sessionB,
    ],
  });
  // The host's "End for everyone" at 13:56 is stamped by our server, which names no Stream session.
  const hostEnd = new Date(s.getTime() + 13 * HOUR + 56 * MIN);
  await prisma.meeting.update({
    where: { id: room.meetingId },
    data: {
      endedAt: hostEnd,
      endedReason: "call_ended",
      streamReportReadySessionIds: ["A"],
      lastStreamSessionId: "A",
    },
  });

  expect(
    await decideSlotOutcome(await loadSlot(room.occurrenceId), {
      now: new Date(
        room.endsAt.getTime() + ATTENDANCE_SETTLE_DELAY_MS + 2 * MIN,
      ),
      outages: [],
    }),
  ).toEqual({ kind: "deferred", reason: "attendance-unsettled" });

  sessionB.hiddenFromStats = false;
  await prisma.meeting.update({
    where: { id: room.meetingId },
    data: { streamReportReadySessionIds: ["A", "B"] },
  });
  expect(
    await decideSlotOutcome(await loadSlot(room.occurrenceId), {
      now: new Date(hostEnd.getTime() + READ_AT),
      outages: [],
    }),
  ).toMatchObject({
    kind: "written",
    moved: true,
    verdict: { outcome: "HELD" },
  });
  expect(await storedOutcome(room.occurrenceId)).toEqual({
    completionStatus: "COMPLETED",
    outcome: "HELD",
  });
});

/** An eight-hour consultation: the host alone for 11 minutes in A (announced), then both in B from hour 6, none of B's webhooks seen. */
async function stageOverrunWithLostWebhooks() {
  const room = await seedConsultationRoom(30, { paid: true, hours: 8 });
  const s = room.startsAt;
  const sessionB = {
    id: "B",
    live: false,
    hiddenFromStats: true,
    stays: [
      stay(room.hostId, s, 6 * HOUR, 13 * HOUR + 56 * MIN),
      stay(room.learnerId, s, 6 * HOUR, 13 * HOUR + 56 * MIN),
    ],
  };
  // At the host's end Stream still names B as the call's session.
  fakeStream.calls.set(room.streamCallId, {
    occurrenceId: room.occurrenceId,
    currentSessionId: "B",
    sessions: [
      { id: "A", live: false, stays: [stay(room.hostId, s, 0, 11 * MIN)] },
      sessionB,
    ],
  });
  await prisma.meeting.update({
    where: { id: room.meetingId },
    data: {
      endedAt: new Date(s.getTime() + 16 * MIN),
      streamReportReadySessionIds: ["A"],
      lastStreamSessionId: "A",
    },
  });
  return {
    room,
    sessionB,
    hostEnd: new Date(s.getTime() + 13 * HOUR + 56 * MIN),
  };
}

it("a host's End for everyone records the session Stream holds, so a lagging overrun session blocks the read until it is listed; then it is HELD", async () => {
  const { room, sessionB, hostEnd } = await stageOverrunWithLostWebhooks();
  await recordMeetingEndedSynchronously(room.streamCallId, hostEnd);
  // Once idle, the call no longer names a current session.
  fakeStream.calls.get(room.streamCallId)!.currentSessionId = undefined;

  expect(
    await decideSlotOutcome(await loadSlot(room.occurrenceId), {
      now: new Date(hostEnd.getTime() + READ_AT),
      outages: [],
    }),
  ).toEqual({ kind: "deferred", reason: "attendance-unsettled" });

  sessionB.hiddenFromStats = false;
  await prisma.meeting.update({
    where: { id: room.meetingId },
    data: { streamReportReadySessionIds: ["A", "B"] },
  });
  expect(
    await decideSlotOutcome(await loadSlot(room.occurrenceId), {
      now: new Date(hostEnd.getTime() + READ_AT),
      outages: [],
    }),
  ).toMatchObject({
    kind: "written",
    moved: true,
    verdict: { outcome: "HELD" },
  });
  expect(await storedOutcome(room.occurrenceId)).toEqual({
    completionStatus: "COMPLETED",
    outcome: "HELD",
  });
});

it("a host's end whose session lookup fails is stamped as before, keeping the session already recorded", async () => {
  const { room, hostEnd } = await stageOverrunWithLostWebhooks();
  fakeStream.failStatus = 503;

  expect(
    await recordMeetingEndedSynchronously(room.streamCallId, hostEnd),
  ).toMatchObject({ kind: "recorded", endedReason: "call_ended" });
  expect(
    await prisma.meeting.findUniqueOrThrow({
      where: { id: room.meetingId },
      select: { endedAt: true, lastStreamSessionId: true },
    }),
  ).toEqual({ endedAt: hostEnd, lastStreamSessionId: "A" });
});

it("a host end that commits during the Stream read moves the cutoff, so the read stamps nothing and the session waits; then it is HELD", async () => {
  const room = await seedConsultationRoom(30, { paid: true, hours: 8 });
  const s = room.startsAt;
  const sessionB = {
    id: "B",
    live: false,
    hiddenFromStats: true,
    stays: [
      stay(room.hostId, s, 6 * HOUR, 14 * HOUR + MIN),
      stay(room.learnerId, s, 6 * HOUR, 14 * HOUR + MIN),
    ],
  };
  // The occurrence listing misses the call, so the read waits on call.get() for it.
  fakeStream.calls.set(room.streamCallId, {
    occurrenceId: "listed-under-another-occurrence",
    sessions: [
      { id: "A", live: false, stays: [stay(room.hostId, s, 0, 11 * MIN)] },
      sessionB,
    ],
  });
  await prisma.meeting.update({
    where: { id: room.meetingId },
    data: {
      endedAt: new Date(s.getTime() + 16 * MIN),
      streamReportReadySessionIds: ["A"],
      lastStreamSessionId: "A",
    },
  });
  let release = () => {};
  fakeStream.getGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const hostEnd = new Date(s.getTime() + 14 * HOUR + MIN);

  const decision = decideSlotOutcome(await loadSlot(room.occurrenceId), {
    now: new Date(room.endsAt.getTime() + ATTENDANCE_SETTLE_DELAY_MS + 2 * MIN),
    outages: [],
  });
  await waitFor(async () => fakeStream.gets >= 1);
  // The host's end commits while Stream is being read; its lookup named no session.
  await prisma.meeting.update({
    where: { id: room.meetingId },
    data: { endedAt: hostEnd, endedReason: "call_ended" },
  });
  release();

  expect(await decision).toEqual({
    kind: "deferred",
    reason: "attendance-unsettled",
  });
  expect(
    (
      await prisma.meeting.findUniqueOrThrow({
        where: { id: room.meetingId },
        select: { attendanceSettledAt: true },
      })
    ).attendanceSettledAt,
  ).toBeNull();

  fakeStream.getGate = null;
  sessionB.hiddenFromStats = false;
  await prisma.meeting.update({
    where: { id: room.meetingId },
    data: { streamReportReadySessionIds: ["A", "B"] },
  });
  expect(
    await decideSlotOutcome(await loadSlot(room.occurrenceId), {
      now: new Date(hostEnd.getTime() + READ_AT),
      outages: [],
    }),
  ).toMatchObject({
    kind: "written",
    moved: true,
    verdict: { outcome: "HELD" },
  });
  expect(await storedOutcome(room.occurrenceId)).toEqual({
    completionStatus: "COMPLETED",
    outcome: "HELD",
  });
});
