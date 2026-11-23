/**
 * @jest-environment node
 */

/**
 * #1607 — three rules for `Meeting.endedAt`:
 *  - a `call.ended` before the booked start is `ended_early`, and the slot stays SCHEDULED
 *  - #1569 D2 — an end webhook never completes the slot; the end + 1 h sweep decides
 *  - the last end wins; an older or replayed event never moves `endedAt` backwards
 *  - each end is a compare-and-set on the call id and the end (stamp and reason) it read
 * A join's reopen is pinned in session-participant-handlers and the database tier.
 */
jest.mock("../../lib/prisma", () => {
  const client: Record<string, unknown> = {
    meeting: {
      findUnique: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
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
} from "../../lib/stream/session-handlers";

const db = prisma as unknown as {
  meeting: { findUnique: jest.Mock; updateMany: jest.Mock };
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
        // A concurrent end moves the stamp or reason, so this write then matches nothing.
        where: {
          id: "ms_1",
          streamCallId: "slot_1",
          endedAt: read,
          endedReason: "session_timeout",
          // A join newer than a non-deliberate end blocks it.
          OR: [
            { lastJoinedAt: null },
            { lastJoinedAt: { lte: expect.any(Date) } },
          ],
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
          // A join newer than a non-deliberate end blocks it.
          OR: [
            { lastJoinedAt: null },
            { lastJoinedAt: { lte: expect.any(Date) } },
          ],
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
