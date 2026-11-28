/**
 * @jest-environment node
 */

// Invariant: the settle stamp stores, with attendanceSettledAt, the sessions the
// read accepted without Stream's ready announcement; a room with no session stores none.

const mockRead = jest.fn();
const mockStamp = jest.fn(async (_args: unknown) => ({ count: 1 }));

jest.mock("../../lib/stream/call-presence", () => ({
  readSettledAttendance: (args: unknown) => mockRead(args),
}));
jest.mock("../../lib/prisma", () => {
  const tx = {
    meeting: { updateMany: (args: unknown) => mockStamp(args) },
    meetingPresence: {
      deleteMany: jest.fn(async () => ({ count: 0 })),
      createMany: jest.fn(async () => ({ count: 0 })),
    },
  };
  return {
    __esModule: true,
    default: {
      $transaction: async (fn: (t: typeof tx) => unknown) => fn(tx),
      meetingPresence: { findMany: jest.fn(async () => []) },
      // A stamp that stored no rows re-reads the room, which is now settled.
      meeting: {
        findUnique: jest.fn(async () => ({
          id: "m-1",
          attendanceSettledAt: new Date(),
        })),
      },
    },
  };
});

import { settleOccurrenceAttendance } from "@/lib/meetings/settle-attendance";

const ENDS = new Date("2026-11-23T05:30:00Z");
const NOW = new Date("2026-11-24T05:30:00Z");
const target = {
  occurrenceId: "occ-1",
  endsAt: ENDS,
  meeting: {
    id: "m-1",
    streamCallId: "call-1",
    extendedSeconds: 0,
    attendanceSettledAt: null,
    endedAt: ENDS,
    endedReason: "session_timeout",
    lastJoinedAt: null,
    streamReportReadySessionIds: ["s-1"],
    lastStreamSessionId: "s-2",
  },
};

beforeEach(() => jest.clearAllMocks());

it.each([
  [
    "a read with a corroborated session",
    {
      kind: "read",
      intervals: [],
      lastSessionEndedAt: null,
      corroboratedSessionIds: ["s-2"],
    },
    ["s-2"],
  ],
  ["a room with no session", { kind: "no-session" }, []],
])("%s stamps its corroborated ids", async (_label, read, ids) => {
  mockRead.mockResolvedValue(read);
  expect(await settleOccurrenceAttendance(target, { now: NOW })).toEqual({
    kind: "settled",
    intervals: [],
  });
  expect(mockStamp.mock.calls[0][0]).toMatchObject({
    data: { attendanceSettledAt: NOW, attendanceCorroboratedSessionIds: ids },
  });
});

it("a read Stream refused for rate keeps that signal when another settler's snapshot answers instead", async () => {
  mockRead.mockResolvedValue({ kind: "unavailable", throttled: true });
  expect(await settleOccurrenceAttendance(target, { now: NOW })).toEqual({
    kind: "settled",
    intervals: [],
    throttled: true,
  });
  expect(mockStamp).not.toHaveBeenCalled();
});
