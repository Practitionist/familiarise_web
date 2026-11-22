/**
 * @jest-environment node
 */

/**
 * The join webhook keeps room state only: a join to the current call after a
 * non-deliberate end clears the end, and nothing about who joined is written.
 * The compare-and-set itself runs on real Postgres in
 * `__tests__/db/stream/room-state-webhooks.db.test.ts`.
 */
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    meeting: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    meetingPresence: { createMany: jest.fn(), updateMany: jest.fn() },
  },
}));
jest.mock("../../lib/stream-logger", () => ({
  streamLogger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn() },
}));

import prisma from "../../lib/prisma";
import { END_REASON_POLICY } from "../../lib/meetings/end-reasons";
import { handleSessionParticipantJoined } from "../../lib/stream/session-handlers";

const db = prisma as unknown as {
  meeting: { updateMany: jest.Mock };
  meetingPresence: { createMany: jest.Mock; updateMany: jest.Mock };
};

it("a join clears only a non-deliberate, rejoinable end older than itself, on the current call, and writes no attendance", async () => {
  await handleSessionParticipantJoined({
    call_cid: "default:occurrence-1",
    type: "call.session_participant_joined",
    created_at: "2026-11-23T04:30:00.000Z",
  });

  const [{ where, data }] = db.meeting.updateMany.mock.calls[0];
  expect(where.streamCallId).toBe("occurrence-1");
  expect(where.endedAt).toEqual({ lt: new Date("2026-11-23T04:30:00.000Z") });
  expect(
    where.endedReason.in.every(
      (r: keyof typeof END_REASON_POLICY) =>
        !END_REASON_POLICY[r].deliberate && END_REASON_POLICY[r].rejoinable,
    ),
  ).toBe(true);
  expect([...where.endedReason.in].sort()).toEqual([
    "ended_early",
    "session_timeout",
  ]);
  expect(data).toEqual({ endedAt: null, endedReason: null });
  expect(db.meetingPresence.createMany).not.toHaveBeenCalled();
  expect(db.meetingPresence.updateMany).not.toHaveBeenCalled();
});
