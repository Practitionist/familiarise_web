/**
 * @jest-environment node
 */

/** A host's end records the session Stream names only if no newer join recorded one while Stream was asked. */
const mockFindUnique = jest.fn();
const mockUpdateMany = jest.fn();
const mockCallGet = jest.fn();

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    meeting: {
      findUnique: (...a: unknown[]) => mockFindUnique(...a),
      updateMany: (...a: unknown[]) => mockUpdateMany(...a),
    },
  },
}));
jest.mock("../../lib/stream-client", () => ({
  isStreamConfigured: () => true,
  withStreamCircuitBreaker: (fn: () => unknown) => fn(),
  getStreamVideoClient: () => ({
    video: { call: () => ({ get: (...a: unknown[]) => mockCallGet(...a) }) },
  }),
}));
jest.mock("../../lib/stream-logger", () => ({
  streamLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { recordMeetingEndedSynchronously } from "../../lib/stream/session-handlers";

const lastJoinedAt = new Date("2026-11-23T14:00:00Z");
const endedAt = new Date("2026-11-23T21:56:00Z");

beforeEach(() => {
  jest.clearAllMocks();
  mockFindUnique.mockResolvedValue({
    id: "m-1",
    streamCallId: "occurrence-o-1",
    endedAt: null,
    endedReason: null,
    lastStreamSessionId: "A",
    lastJoinedAt,
    occurrence: { id: "o-1", startsAt: new Date("2026-11-23T08:00:00Z") },
  });
  mockCallGet.mockResolvedValue({ call: { session: { id: "B" } } });
});

it("records Stream's session with the end only while the room still holds the session and join it read", async () => {
  mockUpdateMany.mockResolvedValue({ count: 1 });

  await recordMeetingEndedSynchronously("occurrence-o-1", endedAt);

  expect(mockUpdateMany).toHaveBeenCalledTimes(1);
  expect(mockUpdateMany.mock.calls[0][0]).toMatchObject({
    where: { lastStreamSessionId: "A", lastJoinedAt },
    data: { endedAt, endedReason: "call_ended", lastStreamSessionId: "B" },
  });
});

it("stamps the end alone when a newer join recorded a session during the lookup", async () => {
  mockUpdateMany
    .mockResolvedValueOnce({ count: 0 })
    .mockResolvedValueOnce({ count: 1 });

  expect(
    await recordMeetingEndedSynchronously("occurrence-o-1", endedAt),
  ).toMatchObject({ kind: "recorded" });

  const endOnly = mockUpdateMany.mock.calls[1][0];
  expect(endOnly.data).toEqual({
    endedAt,
    endedReason: "call_ended",
    isRecording: false,
  });
  expect(endOnly.where).not.toHaveProperty("lastStreamSessionId");
});
