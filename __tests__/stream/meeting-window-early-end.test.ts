/**
 * @jest-environment node
 */

/**
 * #1607 — three rules for `Meeting.endedAt`:
 *  - a `call.ended` before the booked start is `ended_early`, and the slot stays SCHEDULED
 *  - #1569 D2 — an end webhook never completes the slot; the end + 1 h sweep decides
 *  - the last end wins; an older or replayed event never moves `endedAt` backwards
 *  - a participant joining clears a non-deliberate end, never a deliberate one
 */
jest.mock("../../lib/prisma", () => {
  const client: Record<string, unknown> = {
    $executeRaw: jest.fn().mockResolvedValue(1),
    meeting: {
      findUnique: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    meetingAttendance: {
      upsert: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    meetingPresence: {
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      findFirst: jest.fn().mockResolvedValue(null),
    },
  };
  client.$transaction = jest.fn((fn: (tx: unknown) => unknown) => fn(client));
  return { __esModule: true, default: client };
});
jest.mock("../../lib/booking/transitions", () => ({
  transitionOccurrenceCompletion: jest.fn().mockResolvedValue(1),
}));
jest.mock("../../lib/stream-logger", () => ({
  streamLogger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

import prisma from "../../lib/prisma";
import { transitionOccurrenceCompletion } from "../../lib/booking/transitions";
import {
  handleCallEnded,
  handleSessionEnded,
  handleSessionParticipantJoined,
} from "../../lib/stream/session-handlers";

const db = prisma as unknown as {
  $executeRaw: jest.Mock;
  meeting: { findUnique: jest.Mock; updateMany: jest.Mock };
  meetingAttendance: { upsert: jest.Mock };
  meetingPresence: { findFirst: jest.Mock; updateMany: jest.Mock };
};
const mockTransition = transitionOccurrenceCompletion as jest.Mock;

const STARTS = new Date("2026-09-13T10:00:00.000Z");
const ENDS = new Date("2026-09-13T11:00:00.000Z");

function session(endedAt: Date | null, endedReason: string | null = null) {
  return {
    id: "ms_1",
    streamCallId: "slot_1",
    appointmentOccurrenceId: "slot_1",
    endedAt,
    endedReason,
    occurrence: { startsAt: STARTS, endsAt: ENDS },
  };
}

beforeEach(() => jest.clearAllMocks());

describe("call.ended before the booked start (#1607)", () => {
  it("stamps ended_early and leaves the slot SCHEDULED", async () => {
    db.meeting.findUnique.mockResolvedValue(session(null));

    await handleCallEnded({
      call_cid: "default:slot_1",
      type: "call.ended",
      created_at: "2026-09-13T09:48:00.000Z",
    });

    expect(db.meeting.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ endedReason: "ended_early" }),
      }),
    );
    expect(mockTransition).not.toHaveBeenCalled();
  });

  it("stamps call_ended inside the window but leaves completion to the sweep (#1569)", async () => {
    db.meeting.findUnique.mockResolvedValue(session(null));

    await handleCallEnded({
      call_cid: "default:slot_1",
      type: "call.ended",
      created_at: "2026-09-13T10:30:00.000Z",
    });

    expect(db.meeting.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ endedReason: "call_ended" }),
      }),
    );
    expect(mockTransition).not.toHaveBeenCalled();
  });
});

describe("the last end wins (#1607)", () => {
  it("lets a later session_ended overwrite an earlier timeout, CAS on the end it read", async () => {
    const read = new Date("2026-09-13T10:00:30.000Z");
    db.meeting.findUnique.mockResolvedValue(session(read, "session_timeout"));

    await handleSessionEnded({
      call_cid: "default:slot_1",
      type: "call.session_ended",
      created_at: "2026-09-13T11:02:00.000Z",
    });

    expect(db.meeting.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        // A concurrent call.ended moves endedAt, so this write then matches nothing.
        where: {
          id: "ms_1",
          streamCallId: "slot_1",
          endedAt: read,
          endedReason: "session_timeout",
        },
        data: expect.objectContaining({
          endedAt: new Date("2026-09-13T11:02:00.000Z"),
        }),
      }),
    );
  });

  it("never downgrades a deliberate end to a timeout", async () => {
    db.meeting.findUnique.mockResolvedValue(
      session(new Date("2026-09-13T10:30:00.000Z"), "call_ended"),
    );

    await handleSessionEnded({
      call_cid: "default:slot_1",
      type: "call.session_ended",
      created_at: "2026-09-13T10:30:00.400Z",
    });

    expect(db.meeting.updateMany).not.toHaveBeenCalled();
  });

  it("never lets a later call.ended overwrite a deliberate end", async () => {
    for (const reason of ["call_ended", "maintenance", "org_deactivated"]) {
      db.meeting.updateMany.mockClear();
      db.meeting.findUnique.mockResolvedValue(
        session(new Date("2026-09-13T10:30:00.000Z"), reason),
      );

      await handleCallEnded({
        call_cid: "default:slot_1",
        type: "call.ended",
        created_at: "2026-09-13T10:30:01.000Z",
        reason: "session_inactivity_timeout",
      });

      expect(db.meeting.updateMany).not.toHaveBeenCalled();
    }
  });

  it("keeps a Stream-sealed end when a later session_ended arrives", async () => {
    db.meeting.findUnique.mockResolvedValue(
      session(new Date("2026-09-13T10:30:00.000Z"), "stream_ended"),
    );

    await handleSessionEnded({
      call_cid: "default:slot_1",
      type: "call.session_ended",
      created_at: "2026-09-13T10:31:00.000Z",
    });

    expect(db.meeting.updateMany).not.toHaveBeenCalled();
  });

  it("lets a later Stream-sealed end overwrite a timeout", async () => {
    const read = new Date("2026-09-13T10:30:00.000Z");
    db.meeting.findUnique.mockResolvedValue(session(read, "session_timeout"));

    await handleCallEnded({
      call_cid: "default:slot_1",
      type: "call.ended",
      created_at: "2026-09-13T10:31:00.000Z",
      reason: "session_inactivity_timeout",
    });

    expect(db.meeting.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "ms_1",
          streamCallId: "slot_1",
          endedAt: read,
          endedReason: "session_timeout",
        },
        data: expect.objectContaining({ endedReason: "stream_ended" }),
      }),
    );
  });

  it("ignores an older end once a later one is recorded", async () => {
    db.meeting.findUnique.mockResolvedValue(
      session(new Date("2026-09-13T11:02:00.000Z"), "call_ended"),
    );

    await handleSessionEnded({
      call_cid: "default:slot_1",
      type: "call.session_ended",
      created_at: "2026-09-13T10:00:30.000Z",
    });

    expect(db.meeting.updateMany).not.toHaveBeenCalled();
    expect(mockTransition).not.toHaveBeenCalled();
  });
});

describe("a join reopens a non-deliberate end (#1607)", () => {
  const joined = {
    call_cid: "default:slot_1",
    type: "call.session_participant_joined" as const,
    created_at: "2026-09-13T10:02:00.000Z",
    session_id: "sess_2",
    participant: { user: { id: "user_1" } },
  };

  it("clears a timeout end, compare-and-set on the end it read", async () => {
    const stale = new Date("2026-09-13T10:00:30.000Z");
    db.meeting.findUnique.mockResolvedValue({
      id: "ms_1",
      streamCallId: "slot_1",
      endedAt: stale,
      endedReason: "session_timeout",
    });

    await handleSessionParticipantJoined(joined);

    expect(db.meeting.updateMany).toHaveBeenCalledWith({
      where: { id: "ms_1", endedAt: stale },
      data: { endedAt: null, endedReason: null },
    });
    expect(db.meetingAttendance.upsert).toHaveBeenCalled();
  });

  it("ignores a late-delivered join that predates the end", async () => {
    db.meeting.findUnique.mockResolvedValue({
      id: "ms_1",
      streamCallId: "slot_1",
      endedAt: new Date("2026-09-13T10:15:00.000Z"),
      endedReason: "session_timeout",
    });

    await handleSessionParticipantJoined(joined);

    expect(db.meeting.updateMany).not.toHaveBeenCalled();
    expect(db.meetingAttendance.upsert).toHaveBeenCalled();
  });

  it("leaves a deliberate end alone", async () => {
    db.meeting.findUnique.mockResolvedValue({
      id: "ms_1",
      streamCallId: "slot_1",
      endedAt: new Date("2026-09-13T10:30:00.000Z"),
      endedReason: "call_ended",
    });

    await handleSessionParticipantJoined(joined);

    expect(db.meeting.updateMany).not.toHaveBeenCalled();
    expect(db.meetingAttendance.upsert).toHaveBeenCalled();
  });
});

describe("a newer session owns the room", () => {
  const live = () => ({ ...session(null), streamCallId: "slot_1" });
  const lateEnd = {
    call_cid: "default:slot_1",
    type: "call.session_ended" as const,
    created_at: "2026-09-13T10:20:00.000Z",
  };

  it("a late session_ended older than an open join neither stamps the room nor closes the join", async () => {
    db.meeting.findUnique.mockResolvedValue(live());
    db.meetingPresence.findFirst.mockResolvedValueOnce({ id: "p_new" });

    await handleSessionEnded(lateEnd);

    expect(db.meetingPresence.findFirst).toHaveBeenCalledWith({
      where: {
        meetingId: "ms_1",
        leftAt: null,
        joinedAt: { gt: new Date(lateEnd.created_at) },
        OR: [{ streamCallId: "slot_1" }, { streamCallId: null }],
      },
      select: { id: true },
    });
    expect(db.meeting.updateMany).not.toHaveBeenCalled();
    expect(db.meetingPresence.updateMany).not.toHaveBeenCalled();
  });

  it("a host's end still ends a room someone joined after it was sent", async () => {
    db.meeting.findUnique.mockResolvedValue(live());
    db.meetingPresence.findFirst.mockResolvedValue({ id: "p_new" });

    await handleCallEnded({ ...lateEnd, type: "call.ended" });

    expect(db.meetingPresence.findFirst).not.toHaveBeenCalled();
    expect(db.meeting.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ endedReason: "call_ended" }),
      }),
    );
    db.meetingPresence.findFirst.mockResolvedValue(null);
  });

  it("a join re-reads the room under its row lock and reopens an end that landed after its first read", async () => {
    const endedAt = new Date("2026-09-13T10:20:00.000Z");
    db.meeting.findUnique
      .mockResolvedValueOnce({ ...session(null), streamCallId: "slot_1" })
      .mockResolvedValueOnce({
        streamCallId: "slot_1",
        endedAt,
        endedReason: "session_timeout",
      });

    await handleSessionParticipantJoined({
      call_cid: "default:slot_1",
      type: "call.session_participant_joined",
      created_at: "2026-09-13T10:21:00.000Z",
      session_id: "sess_2",
      participant: { user: { id: "user_1" } },
    });

    expect(db.$executeRaw).toHaveBeenCalled();
    expect(db.meeting.updateMany).toHaveBeenCalledWith({
      where: { id: "ms_1", endedAt },
      data: { endedAt: null, endedReason: null },
    });
  });

  it("a join whose call id the room rotated away from before its lock takes the prior-segment path", async () => {
    db.meeting.findUnique
      .mockResolvedValueOnce({ ...session(null), streamCallId: "slot_1" })
      .mockResolvedValueOnce({
        streamCallId: "slot_1-r1",
        endedAt: new Date("2026-09-13T10:20:00.000Z"),
        endedReason: "session_timeout",
      });

    await handleSessionParticipantJoined({
      call_cid: "default:slot_1",
      type: "call.session_participant_joined",
      created_at: "2026-09-13T10:21:00.000Z",
      session_id: "sess_2",
      participant: { user: { id: "user_1" } },
    });

    expect(db.meeting.updateMany).not.toHaveBeenCalled();
    const upsert = db.meetingAttendance.upsert.mock.calls[0][0];
    expect(upsert.update).toEqual({ joinCount: { increment: 1 } });
    expect(upsert.create.lastLeftAt).toBeUndefined();
  });
});

describe("a host end beats a non-deliberate end on the same call", () => {
  beforeEach(() => {
    db.meeting.findUnique.mockReset();
    db.meeting.updateMany.mockReset().mockResolvedValue({ count: 1 });
  });
  const hostEnd = (createdAt: string) =>
    handleCallEnded({
      call_cid: "default:slot_1",
      type: "call.ended",
      created_at: createdAt,
      user: { id: "host_1" },
    });

  it("a host end that loses its CAS to a timeout re-reads the room and records the host's end", async () => {
    const timeoutAt = new Date("2026-09-13T10:10:00.000Z");
    db.meeting.findUnique
      .mockResolvedValueOnce(session(null))
      .mockResolvedValueOnce({
        streamCallId: "slot_1",
        endedAt: timeoutAt,
        endedReason: "session_timeout",
      });
    db.meeting.updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });

    await hostEnd("2026-09-13T10:10:05.000Z");

    expect(db.meeting.updateMany).toHaveBeenLastCalledWith({
      where: {
        id: "ms_1",
        streamCallId: "slot_1",
        endedAt: timeoutAt,
        endedReason: "session_timeout",
      },
      data: {
        endedAt: new Date("2026-09-13T10:10:05.000Z"),
        endedReason: "call_ended",
        isRecording: false,
      },
    });
  });

  it("a timeout that loses its CAS to a host end leaves the host's end", async () => {
    db.meeting.findUnique
      .mockResolvedValueOnce(session(null))
      .mockResolvedValueOnce({
        streamCallId: "slot_1",
        endedAt: new Date("2026-09-13T10:10:05.000Z"),
        endedReason: "call_ended",
      });
    db.meeting.updateMany.mockResolvedValueOnce({ count: 0 });

    await handleSessionEnded({
      call_cid: "default:slot_1",
      type: "call.session_ended",
      created_at: "2026-09-13T10:10:00.000Z",
    });

    expect(db.meeting.updateMany).toHaveBeenCalledTimes(1);
  });

  it("a host end replaces a recorded timeout even when the timeout's stamp is later", async () => {
    const timeoutAt = new Date("2026-09-13T10:10:05.000Z");
    db.meeting.findUnique.mockResolvedValue(
      session(timeoutAt, "session_timeout"),
    );

    await hostEnd("2026-09-13T10:10:00.000Z");

    expect(db.meeting.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "ms_1",
          streamCallId: "slot_1",
          endedAt: timeoutAt,
          endedReason: "session_timeout",
        },
        data: expect.objectContaining({ endedReason: "call_ended" }),
      }),
    );
  });
});
