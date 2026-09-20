/**
 * @jest-environment node
 */

/**
 * #1607 — three rules for `Meeting.endedAt`:
 *  - a `call.ended` before the booked start is `ended_early`, and the slot stays SCHEDULED
 *  - the last end wins; an older or replayed event never moves `endedAt` backwards
 *  - a participant joining clears a non-deliberate end, never a deliberate one
 */
jest.mock("../../lib/prisma", () => {
  const tx = {
    meeting: { update: jest.fn().mockResolvedValue({}) },
    // #1766 — the cycle bell reads the wrapper after a completion; a
    // consultation wrapper (no subscription) stages nothing.
    appointment: { findUnique: jest.fn().mockResolvedValue(null) },
  };
  const client = {
    meeting: {
      findUnique: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    meetingAttendance: { upsert: jest.fn().mockResolvedValue({}) },
    $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
    __tx: tx,
  };
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
  meeting: { findUnique: jest.Mock; updateMany: jest.Mock };
  meetingAttendance: { upsert: jest.Mock };
  __tx: { meeting: { update: jest.Mock } };
};
const mockTransition = transitionOccurrenceCompletion as jest.Mock;

const STARTS = new Date("2026-09-13T10:00:00.000Z");
const ENDS = new Date("2026-09-13T11:00:00.000Z");

function session(endedAt: Date | null, endedReason: string | null = null) {
  return {
    id: "ms_1",
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

    expect(db.__tx.meeting.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ endedReason: "ended_early" }),
      }),
    );
    expect(mockTransition).not.toHaveBeenCalled();
  });

  it("still completes the slot for a deliberate end inside the window", async () => {
    db.meeting.findUnique.mockResolvedValue(session(null));

    await handleCallEnded({
      call_cid: "default:slot_1",
      type: "call.ended",
      created_at: "2026-09-13T10:30:00.000Z",
    });

    expect(db.__tx.meeting.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ endedReason: "call_ended" }),
      }),
    );
    expect(mockTransition).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ to: "COMPLETED", fromIn: ["SCHEDULED"] }),
    );
  });
});

describe("the last end wins (#1607)", () => {
  it("lets a later session_ended overwrite an earlier timeout", async () => {
    db.meeting.findUnique.mockResolvedValue(
      session(new Date("2026-09-13T10:00:30.000Z"), "session_timeout"),
    );

    await handleSessionEnded({
      call_cid: "default:slot_1",
      type: "call.session_ended",
      created_at: "2026-09-13T11:02:00.000Z",
    });

    expect(db.__tx.meeting.update).toHaveBeenCalledWith(
      expect.objectContaining({
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

    expect(db.__tx.meeting.update).not.toHaveBeenCalled();
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

    expect(db.__tx.meeting.update).not.toHaveBeenCalled();
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
      endedAt: new Date("2026-09-13T10:30:00.000Z"),
      endedReason: "call_ended",
    });

    await handleSessionParticipantJoined(joined);

    expect(db.meeting.updateMany).not.toHaveBeenCalled();
    expect(db.meetingAttendance.upsert).toHaveBeenCalled();
  });
});
