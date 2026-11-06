/** @jest-environment node */
const findMeetings = jest.fn();
const transaction = jest.fn();
const endCall = jest.fn();
const stopRecording = jest.fn();
const updateChannel = jest.fn();
const recordMeeting = jest.fn();
const markChannels = jest.fn();
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    meeting: {
      findMany: (...args: unknown[]) => findMeetings(...args),
      count: async () => 0,
      update: (...args: unknown[]) => recordMeeting(...args),
      updateMany: (...args: unknown[]) => markChannels(...args),
    },
    maintenanceWindow: {
      findFirst: async () => ({
        id: "window",
        startedAt: new Date("2026-10-22T00:00Z"),
      }),
    },
    $transaction: (...args: unknown[]) => transaction(...args),
  },
}));
jest.mock("@stream-io/node-sdk", () => ({
  StreamClient: jest.fn().mockImplementation(() => ({
    video: {
      call: () => ({
        end: () => endCall(),
        stopRecording: (...args: unknown[]) => stopRecording(...args),
      }),
    },
    chat: {
      channel: () => ({
        updateChannelPartial: (...args: unknown[]) => updateChannel(...args),
      }),
    },
  })),
}));
jest.mock("../../lib/booking/transitions", () => ({
  transitionOccurrenceCompletion: jest.fn(),
}));
jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));
import { StreamClient } from "@stream-io/node-sdk";
import {
  drainActiveSessions,
  unfreezeChannelsAfterMaintenance,
} from "../../actions/maintenance/drain-sessions";
const session = (id: string) => ({
  id,
  streamCallId: id,
  appointmentOccurrenceId: id,
  isRecording: false,
  occurrence: { appointment: { participants: [{ userId: id }] } },
});
beforeEach(() => {
  jest.clearAllMocks();
  process.env.NEXT_PUBLIC_STREAM_API_KEY = "test-key";
  process.env.STREAM_API_SECRET = "test-secret";
  endCall.mockResolvedValue(undefined);
  stopRecording.mockResolvedValue(undefined);
  transaction.mockResolvedValue(undefined);
  markChannels.mockResolvedValue({ count: 1 });
  updateChannel.mockResolvedValue(undefined);
});
it("continues after a failed drain commit and freezes durably ended group calls", async () => {
  findMeetings
    .mockResolvedValueOnce([session("a"), session("b")])
    .mockResolvedValueOnce([
      {
        id: "b",
        occurrence: { appointment: { webinarId: "event", classId: null } },
      },
    ]);
  transaction
    .mockRejectedValueOnce(new Error("deadlock"))
    .mockResolvedValueOnce(undefined);
  const result = await drainActiveSessions();
  expect(endCall).toHaveBeenCalledTimes(2);
  expect(result.drained).toBe(1);
  expect(result.errors.join(" ")).toContain("deadlock");
  expect(updateChannel).toHaveBeenCalledWith({ set: { frozen: true } });
  expect(markChannels).toHaveBeenCalledWith(
    expect.objectContaining({
      where: {
        id: { in: ["b"] },
        maintenanceChannelFrozenAt: null,
        maintenanceWindowId: "window",
      },
    }),
  );
});
it("uses an isolated bounded transport and records recording stops after acknowledgement", async () => {
  findMeetings
    .mockResolvedValueOnce([{ ...session("recording"), isRecording: true }])
    .mockResolvedValueOnce([]);
  const result = await drainActiveSessions();
  expect(StreamClient).toHaveBeenCalledWith("test-key", "test-secret", {
    timeout: 3000,
  });
  expect(stopRecording).toHaveBeenCalledWith({ recording_type: "composite" });
  expect(recordMeeting).toHaveBeenCalledWith({
    where: { id: "recording" },
    data: { isRecording: false },
  });
  expect(result.recordingsStopped).toBe(1);
  expect(result.drained).toBe(1);
});
it("finishes recovery without a vendor call when no stamped meetings remain", async () => {
  findMeetings.mockResolvedValue([]);
  expect(await unfreezeChannelsAfterMaintenance()).toEqual({
    unfrozen: 0,
    remaining: 0,
    errors: [],
  });
  expect(updateChannel).not.toHaveBeenCalled();
});
