/**
 * @jest-environment node
 */

const mockMeetingFindMany = jest.fn();
const mockMeetingUpdateMany = jest.fn();
const mockPresenceUpdateMany = jest.fn();
const mockCallGet = jest.fn();

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    meeting: {
      findMany: (...a: unknown[]) => mockMeetingFindMany(...a),
      updateMany: (...a: unknown[]) => mockMeetingUpdateMany(...a),
    },
    meetingPresence: {
      updateMany: (...a: unknown[]) => mockPresenceUpdateMany(...a),
    },
  },
}));

jest.mock("../../lib/stream-client", () => ({
  isStreamConfigured: jest.fn(() => true),
  withStreamCircuitBreaker: (fn: () => unknown) => fn(),
  getStreamVideoClient: jest.fn(() => ({
    video: {
      call: () => ({
        get: (...a: unknown[]) => mockCallGet(...a),
      }),
    },
  })),
}));

import { reconcileOrphanedSessions } from "../../lib/meetings/reconcile-orphaned-sessions";

beforeEach(() => {
  jest.clearAllMocks();
});

describe("reconcileOrphanedSessions", () => {
  it("queries orphaned meetings oldest-first and closes dangling MeetingPresence rows when stamping endedAt", async () => {
    const slotStartsAt = new Date("2026-10-01T10:00:00.000Z");
    const slotEndsAt = new Date("2026-10-01T11:00:00.000Z");
    const streamEndedAt = new Date("2026-10-01T11:02:00.000Z");

    mockMeetingFindMany.mockResolvedValue([
      {
        id: "meeting-orphan-1",
        streamCallId: "occurrence-slot-1",
        appointmentOccurrenceId: "slot-1",
        occurrence: {
          startsAt: slotStartsAt,
          endsAt: slotEndsAt,
          completionStatus: "SCHEDULED",
        },
      },
    ]);
    mockCallGet.mockResolvedValue({
      call: {
        id: "occurrence-slot-1",
        ended_at: streamEndedAt.toISOString(),
      },
    });
    mockMeetingUpdateMany.mockResolvedValue({ count: 1 });
    mockPresenceUpdateMany.mockResolvedValue({ count: 2 });

    const result = await reconcileOrphanedSessions();

    expect(mockMeetingFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: { occurrence: { endsAt: "asc" } },
      }),
    );
    expect(mockMeetingUpdateMany).toHaveBeenCalledWith({
      where: { id: "meeting-orphan-1", endedAt: null },
      data: {
        endedAt: streamEndedAt,
        endedReason: "reconciled",
      },
    });
    expect(mockPresenceUpdateMany).toHaveBeenCalledWith({
      where: {
        meetingId: "meeting-orphan-1",
        leftAt: null,
      },
      data: {
        leftAt: streamEndedAt,
      },
    });
    expect(result.reconciled).toBe(1);
  });
});
