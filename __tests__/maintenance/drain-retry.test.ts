/** @jest-environment node */
const findMeetings = jest.fn();
const countMeetings = jest.fn();
const updateMeetings = jest.fn();
const updateChannel = jest.fn();
const stopRecording = jest.fn();
const endCall = jest.fn();
jest.mock("@sentry/core", () => jest.requireMock("@sentry/nextjs"));
jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    meeting: {
      findMany: (...args: unknown[]) => findMeetings(...args),
      count: (...args: unknown[]) => countMeetings(...args),
      updateMany: (...args: unknown[]) => updateMeetings(...args),
    },
    maintenanceWindow: {
      findFirst: async () => ({ id: "window" }),
    },
  },
}));
jest.mock("@stream-io/node-sdk", () => ({
  StreamClient: jest.fn().mockImplementation(() => ({
    video: {
      call: () => ({
        stopRecording: (...args: unknown[]) => stopRecording(...args),
        end: () => endCall(),
      }),
    },
    chat: {
      channel: (_type: string, id: string) => ({
        updateChannelPartial: (data: unknown) => updateChannel(id, data),
      }),
    },
  })),
}));
jest.mock("../../lib/booking/transitions", () => ({
  transitionOccurrenceCompletion: jest.fn(),
}));
jest.mock("../../lib/novu/service", () => ({
  stageMaintenanceBells: jest.fn(),
}));
import * as Sentry from "@sentry/nextjs";
import {
  drainActiveSessions,
  unfreezeChannelsAfterMaintenance,
} from "../../actions/maintenance/drain-sessions";
const row = (id: string) => ({
  id,
  occurrence: { appointment: { webinarId: id, classId: null } },
});
beforeEach(() => {
  jest.clearAllMocks();
  process.env.NEXT_PUBLIC_STREAM_API_KEY = "test-key";
  process.env.STREAM_API_SECRET = "test-secret";
  countMeetings.mockResolvedValue(0);
  updateMeetings.mockResolvedValue({ count: 1 });
  updateChannel.mockResolvedValue(undefined);
  stopRecording.mockResolvedValue(undefined);
  endCall.mockResolvedValue(undefined);
});
it("freezes already-ended meetings after a crash before the vendor call", async () => {
  findMeetings.mockResolvedValueOnce([]).mockResolvedValueOnce([row("ended")]);
  const result = await drainActiveSessions();
  expect(result.errors).toEqual([]);
  expect(updateChannel).toHaveBeenCalledWith(expect.stringContaining("ended"), {
    set: { frozen: true },
  });
  expect(updateMeetings).toHaveBeenCalledWith(
    expect.objectContaining({
      data: { maintenanceChannelFrozenAt: expect.any(Date) },
    }),
  );
});
it("retains failed freezes for retry and reports once for the run", async () => {
  findMeetings.mockResolvedValueOnce([]).mockResolvedValueOnce([row("failed")]);
  countMeetings.mockResolvedValueOnce(0).mockResolvedValueOnce(1);
  updateChannel.mockRejectedValue(new Error("Stream unavailable"));
  const result = await drainActiveSessions();
  expect(result.remainingChannelFreezes).toBe(1);
  expect(result.errors.length).toBeGreaterThan(0);
  expect(updateMeetings).not.toHaveBeenCalledWith(
    expect.objectContaining({
      data: { maintenanceChannelFrozenAt: expect.any(Date) },
    }),
  );
  expect(Sentry.captureException).toHaveBeenCalledTimes(1);
});

it("keeps a call live and retryable when stopping its recording is not acknowledged", async () => {
  findMeetings
    .mockResolvedValueOnce([
      {
        id: "recording",
        streamCallId: "recording",
        isRecording: true,
        occurrence: { appointment: { participants: [] } },
      },
    ])
    .mockResolvedValueOnce([]);
  countMeetings.mockResolvedValueOnce(1).mockResolvedValueOnce(0);
  stopRecording.mockRejectedValue(new Error("recording stop unavailable"));
  const result = await drainActiveSessions();
  expect(result.recordingsStopped).toBe(0);
  expect(result.remainingSessions).toBe(1);
  expect(endCall).not.toHaveBeenCalled();
  expect(result.errors.join(" ")).toContain("recording stop unavailable");
});
it("reports an active-call backlog instead of completing setup", async () => {
  findMeetings.mockResolvedValue([]);
  countMeetings.mockResolvedValueOnce(3).mockResolvedValueOnce(0);
  const result = await drainActiveSessions();
  expect(result.remainingSessions).toBe(3);
  expect(result.errors).toContain(
    "Offline setup has a remaining backlog; retry activation.",
  );
});
it("does not end a call whose identity changed before its maintenance claim", async () => {
  findMeetings
    .mockResolvedValueOnce([
      {
        id: "changed",
        streamCallId: "previous-call",
        occurrence: { appointment: { participants: [] } },
      },
    ])
    .mockResolvedValueOnce([]);
  updateMeetings.mockResolvedValueOnce({ count: 0 });
  countMeetings.mockResolvedValueOnce(1).mockResolvedValueOnce(0);
  const result = await drainActiveSessions();
  expect(endCall).not.toHaveBeenCalled();
  expect(result.remainingSessions).toBe(1);
});
it("clears only acknowledged unfreezes", async () => {
  findMeetings.mockResolvedValue([row("good"), row("bad")]);
  updateChannel.mockImplementation((id: string) =>
    id.includes("bad")
      ? Promise.reject(new Error("failed"))
      : Promise.resolve(),
  );
  countMeetings.mockResolvedValue(1);
  const result = await unfreezeChannelsAfterMaintenance();
  expect(result.remaining).toBe(1);
  expect(result.errors.length).toBeGreaterThan(0);
  expect(updateMeetings).toHaveBeenCalledWith(
    expect.objectContaining({
      where: {
        id: { in: ["good"] },
        maintenanceWindowId: "window",
        maintenanceChannelRecoveredAt: null,
      },
      data: {
        maintenanceChannelFrozenAt: null,
        maintenanceChannelRecoveredAt: expect.any(Date),
      },
    }),
  );
});
it("replays an acknowledged unfreeze when its database stamp failed", async () => {
  findMeetings.mockResolvedValue([row("booking")]);
  updateMeetings.mockRejectedValueOnce(new Error("lost acknowledgement write"));
  expect(
    (await unfreezeChannelsAfterMaintenance()).errors.length,
  ).toBeGreaterThan(0);
  expect((await unfreezeChannelsAfterMaintenance()).errors).toEqual([]);
  expect(updateChannel).toHaveBeenCalledTimes(2);
});
it("recovers a freeze applied before its acknowledgement stamp was saved", async () => {
  findMeetings
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([row("uncertain")])
    .mockResolvedValueOnce([row("uncertain")]);
  updateMeetings
    .mockResolvedValueOnce({ count: 1 })
    .mockRejectedValueOnce(new Error("lost freeze acknowledgement"));
  expect((await drainActiveSessions()).errors.join(" ")).toContain(
    "lost freeze acknowledgement",
  );
  expect((await unfreezeChannelsAfterMaintenance()).errors).toEqual([]);
  expect(updateChannel).toHaveBeenLastCalledWith(
    expect.stringContaining("uncertain"),
    { set: { frozen: false } },
  );
  const recoveryQuery = findMeetings.mock.calls[2][0];
  expect(recoveryQuery.where).toMatchObject({
    maintenanceWindowId: "window",
    maintenanceChannelRecoveredAt: null,
  });
  expect(recoveryQuery.where).not.toHaveProperty("maintenanceChannelFrozenAt");
});
it("queries bounded recovery work by exact maintenance window identity", async () => {
  findMeetings.mockResolvedValue([]);
  await unfreezeChannelsAfterMaintenance();
  expect(findMeetings).toHaveBeenCalledWith(
    expect.objectContaining({
      take: 200,
      where: expect.objectContaining({
        maintenanceWindowId: "window",
        maintenanceChannelRecoveredAt: null,
      }),
    }),
  );
});

it("leaves work queued when the request budget is spent before a vendor batch", async () => {
  findMeetings.mockResolvedValue([row("pending")]);
  countMeetings.mockResolvedValue(1);
  const now = jest
    .spyOn(Date, "now")
    .mockReturnValueOnce(0)
    .mockReturnValue(13_000);
  try {
    const result = await unfreezeChannelsAfterMaintenance();
    expect(result.remaining).toBe(1);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(updateChannel).not.toHaveBeenCalled();
    expect(updateMeetings).not.toHaveBeenCalled();
  } finally {
    now.mockRestore();
  }
});
