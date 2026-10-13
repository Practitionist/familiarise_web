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

import {
  BATCH_SIZE,
  reconcileOrphanedSessions,
} from "../../lib/meetings/reconcile-orphaned-sessions";

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
        orderBy: [{ occurrence: { endsAt: "asc" } }, { id: "asc" }],
        take: BATCH_SIZE,
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

  it("advances cursor across pages so active or failing rows in page 1 cannot starve page 2", async () => {
    const slotEndsAt = new Date("2026-10-01T11:00:00.000Z");
    const streamEndedAt = new Date("2026-10-01T11:05:00.000Z");

    const page1 = Array.from({ length: BATCH_SIZE }, (_, i) => ({
      id: `meeting-p1-${i + 1}`,
      streamCallId: `call-p1-${i + 1}`,
      occurrence: { endsAt: slotEndsAt },
    }));
    const page2 = [
      {
        id: "meeting-p2-1",
        streamCallId: "call-p2-1",
        occurrence: { endsAt: slotEndsAt },
      },
    ];

    mockMeetingFindMany
      .mockResolvedValueOnce(page1)
      .mockResolvedValueOnce(page2);

    // Every call in page 1 is still active on Stream (skipped without updating endedAt),
    // while page 2's call has ended and should be reconciled.
    mockCallGet.mockImplementation(() => {
      const callCount = mockCallGet.mock.calls.length;
      if (callCount <= BATCH_SIZE) {
        return Promise.resolve({
          call: {
            ended_at: null,
            session: { ended_at: null, participants: [{ user_id: "u1" }] },
          },
        });
      }
      return Promise.resolve({
        call: {
          ended_at: streamEndedAt.toISOString(),
        },
      });
    });
    mockMeetingUpdateMany.mockResolvedValue({ count: 1 });
    mockPresenceUpdateMany.mockResolvedValue({ count: 1 });

    const result = await reconcileOrphanedSessions();

    expect(mockMeetingFindMany).toHaveBeenCalledTimes(2);
    expect(mockMeetingFindMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        cursor: { id: `meeting-p1-${BATCH_SIZE}` },
        skip: 1,
        take: BATCH_SIZE,
      }),
    );
    expect(result.processed).toBe(BATCH_SIZE + 1);
    expect(result.reconciled).toBe(1);
  });
});
