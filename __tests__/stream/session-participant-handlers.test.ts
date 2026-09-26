/**
 * @jest-environment node
 */

/**
 * STR-4 — per-attendee presence handlers. Verifies the join/leave webhook
 * handlers resolve the Meeting by streamCallId and upsert a
 * MeetingAttendance row keyed on [meetingId, userId]:
 *  - first join stamps firstJoinedAt (create branch)
 *  - rejoin only increments joinCount (update branch, firstJoinedAt untouched)
 *  - leave stamps lastLeftAt
 *  - missing session / missing user id are skipped, not thrown
 */
jest.mock("../../lib/prisma", () => {
  const client: Record<string, unknown> = {
    meeting: { findUnique: jest.fn() },
    meetingAttendance: { upsert: jest.fn().mockResolvedValue({}) },
    meetingPresence: {
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
  };
  client.$transaction = jest.fn((fn: (tx: unknown) => unknown) => fn(client));
  return { __esModule: true, default: client };
});
jest.mock("../../lib/stream-logger", () => ({
  streamLogger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

import prisma from "../../lib/prisma";
import {
  handleSessionParticipantJoined,
  handleSessionParticipantLeft,
} from "../../lib/stream/session-handlers";

const mockFindUnique = (
  prisma as unknown as { meeting: { findUnique: jest.Mock } }
).meeting.findUnique;
const mockUpsert = (
  prisma as unknown as { meetingAttendance: { upsert: jest.Mock } }
).meetingAttendance.upsert;
const mockPresenceCreate = (
  prisma as unknown as { meetingPresence: { createMany: jest.Mock } }
).meetingPresence.createMany;

beforeEach(() => jest.clearAllMocks());

describe("handleSessionParticipantJoined (STR-4)", () => {
  it("creates attendance with firstJoinedAt on first join (create branch)", async () => {
    mockFindUnique.mockResolvedValue({
      id: "ms_1",
      appointmentOccurrenceId: "occ_1",
    });

    await handleSessionParticipantJoined({
      call_cid: "default:call_abc",
      type: "call.session_participant_joined",
      created_at: "2026-06-16T10:00:00.000Z",
      session_id: "sess_1",
      participant: { user: { id: "user_1" }, user_session_id: "dev_1" },
    });

    // Resolved by the call id stripped from call_cid ("default:call_abc")
    expect(mockFindUnique).toHaveBeenCalledWith({
      where: { streamCallId: "call_abc" },
      select: {
        id: true,
        endedAt: true,
        endedReason: true,
        appointmentOccurrenceId: true,
      },
    });

    const arg = mockUpsert.mock.calls[0][0];
    expect(arg.where).toEqual({
      meetingId_userId: { meetingId: "ms_1", userId: "user_1" },
    });
    // #1554 — the row names the call it belongs to, so the rating gate reads
    // "you were at THIS call" straight off the occurrence.
    expect(arg.create).toMatchObject({
      meetingId: "ms_1",
      appointmentOccurrenceId: "occ_1",
      userId: "user_1",
      firstJoinedAt: new Date("2026-06-16T10:00:00.000Z"),
    });
    // A new device session bumps the counter, never resets firstJoinedAt.
    expect(arg.update).toEqual({ joinCount: { increment: 1 } });
  });

  it("does not bump joinCount when the device session was already seen (#1746)", async () => {
    mockFindUnique.mockResolvedValue({
      id: "ms_1",
      appointmentOccurrenceId: "occ_1",
    });
    mockPresenceCreate.mockResolvedValueOnce({ count: 0 });
    await handleSessionParticipantJoined({
      call_cid: "default:call_abc",
      type: "call.session_participant_joined",
      created_at: "2026-06-16T10:00:00.000Z",
      session_id: "sess_1",
      participant: { user: { id: "user_1" }, user_session_id: "dev_1" },
    });
    expect(mockUpsert.mock.calls[0][0].update).toEqual({});
  });

  it("skips when meeting session does not exist (no throw)", async () => {
    mockFindUnique.mockResolvedValue(null);

    await expect(
      handleSessionParticipantJoined({
        call_cid: "default:missing",
        type: "call.session_participant_joined",
        created_at: "2026-06-16T10:00:00.000Z",
        session_id: "sess_1",
        participant: { user: { id: "user_1" } },
      }),
    ).resolves.toBeUndefined();

    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("skips when participant user id is missing", async () => {
    await handleSessionParticipantJoined({
      call_cid: "default:call_abc",
      type: "call.session_participant_joined",
      created_at: "2026-06-16T10:00:00.000Z",
      session_id: "sess_1",
      // @ts-expect-error — exercising the defensive guard for a malformed payload
      participant: { user: {} },
    });

    expect(mockFindUnique).not.toHaveBeenCalled();
    expect(mockUpsert).not.toHaveBeenCalled();
  });
});

describe("handleSessionParticipantLeft (STR-4)", () => {
  it("stamps lastLeftAt on leave (update branch)", async () => {
    mockFindUnique.mockResolvedValue({ id: "ms_1" });

    await handleSessionParticipantLeft({
      call_cid: "default:call_abc",
      type: "call.session_participant_left",
      created_at: "2026-06-16T10:30:00.000Z",
      session_id: "sess_1",
      duration_seconds: 1800,
      participant: { user: { id: "user_1" } },
    });

    const arg = mockUpsert.mock.calls[0][0];
    expect(arg.where).toEqual({
      meetingId_userId: { meetingId: "ms_1", userId: "user_1" },
    });
    expect(arg.update).toEqual({
      lastLeftAt: new Date("2026-06-16T10:30:00.000Z"),
      joinCount: { increment: 1 },
    });
    // #1569 — join lost, leave arrives: one closed interval rebuilt from duration_seconds.
    expect(mockPresenceCreate.mock.calls[0][0].data).toEqual([
      expect.objectContaining({
        userSessionId: "sess_1:user_1",
        joinedAt: new Date("2026-06-16T10:00:00.000Z"),
        leftAt: new Date("2026-06-16T10:30:00.000Z"),
      }),
    ]);
    expect(arg.create).toMatchObject({
      meetingId: "ms_1",
      userId: "user_1",
      firstJoinedAt: new Date("2026-06-16T10:00:00.000Z"),
      lastLeftAt: new Date("2026-06-16T10:30:00.000Z"),
    });
  });

  it("skips when meeting session does not exist (no throw)", async () => {
    mockFindUnique.mockResolvedValue(null);

    await expect(
      handleSessionParticipantLeft({
        call_cid: "default:missing",
        type: "call.session_participant_left",
        created_at: "2026-06-16T10:30:00.000Z",
        session_id: "sess_1",
        participant: { user: { id: "user_1" } },
      }),
    ).resolves.toBeUndefined();

    expect(mockUpsert).not.toHaveBeenCalled();
  });
});
