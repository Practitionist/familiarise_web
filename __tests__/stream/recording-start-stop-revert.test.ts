/**
 * @jest-environment node
 */

jest.mock("@sentry/nextjs", () => ({
  __esModule: true,
  captureException: jest.fn(),
}));
jest.mock("../../lib/auth-server", () => ({
  __esModule: true,
  getSession: jest.fn(async () => ({
    user: { id: "host-1", consultantProfileId: "cp-1" },
  })),
}));
jest.mock("../../lib/stream/recording-service", () => ({
  __esModule: true,
  RecordingService: {
    startRecording: jest.fn(async () => ({ success: false, error: "504" })),
    stopRecording: jest.fn(async () => ({ success: false, error: "504" })),
  },
}));
jest.mock("../../lib/stream/recording-consent", () => ({
  consentRegimeFor: () => "ACKNOWLEDGE",
  getRecordingBlock: async () => ({ blocked: false }),
}));
jest.mock("../../lib/stream/recording-utils", () => ({
  getMeetingOwnershipInfo: () => ({ isOwner: true, recordingEnabled: true }),
}));
jest.mock("../../lib/stream-logger", () => ({
  streamLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    meeting: {
      findUnique: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
    consultantProfile: { findUnique: jest.fn(async () => ({ id: "cp-1" })) },
  },
}));

import { NextRequest } from "next/server";
import prisma from "../../lib/prisma";
import { POST as start } from "../../app/api/stream/recordings/start/route";
import { POST as stop } from "../../app/api/stream/recordings/stop/route";

const post = (path: string) =>
  new NextRequest(`http://localhost${path}`, {
    method: "POST",
    body: JSON.stringify({ meetingId: "m-1" }),
  });
const updateMany = prisma.meeting.updateMany as jest.Mock;

describe("recording start/stop reverts", () => {
  beforeEach(() => jest.clearAllMocks());

  it("a failed start reverts only the claim this request wrote", async () => {
    (prisma.meeting.findUnique as jest.Mock).mockResolvedValue({
      id: "m-1",
      streamCallId: "occurrence-1",
      isRecording: false,
      endedAt: null,
      occurrence: {
        completionStatus: "SCHEDULED",
        outcome: null,
        deletedAt: null,
        appointment: {},
      },
    });

    const res = await start(post("/api/stream/recordings/start"));

    expect(res.status).toBe(502);
    // The claim itself refuses an ended or classified room.
    expect(updateMany.mock.calls[0][0].where).toMatchObject({
      isRecording: false,
      endedAt: null,
      occurrence: { completionStatus: "SCHEDULED", outcome: null },
    });
    const claimedAt = updateMany.mock.calls[0][0].data.recordingStartedAt;
    expect(updateMany).toHaveBeenLastCalledWith({
      where: {
        id: "m-1",
        isRecording: true,
        recordingStartedAt: claimedAt,
        recordingStartedBy: "host-1",
      },
      data: {
        isRecording: false,
        recordingStartedAt: null,
        recordingStartedBy: null,
      },
    });
    expect(prisma.meeting.update).not.toHaveBeenCalled();
  });

  it("a failed stop restores only the segment it stopped, on a live meeting", async () => {
    const startedAt = new Date("2026-10-03T10:00:00.000Z");
    (prisma.meeting.findUnique as jest.Mock).mockResolvedValue({
      id: "m-1",
      streamCallId: "occurrence-1",
      isRecording: true,
      recordingStartedAt: startedAt,
      occurrence: { appointment: {} },
    });

    const res = await stop(post("/api/stream/recordings/stop"));

    expect(res.status).toBe(502);
    expect(updateMany).toHaveBeenLastCalledWith({
      where: {
        id: "m-1",
        isRecording: false,
        endedAt: null,
        streamCallId: "occurrence-1",
        recordingStartedAt: startedAt,
      },
      data: { isRecording: true },
    });
    expect(prisma.meeting.update).not.toHaveBeenCalled();
  });
});
