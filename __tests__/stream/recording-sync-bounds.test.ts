/**
 * @jest-environment node
 */

const mockStageReady = jest.fn();
jest.mock("../../lib/stream/recording-handlers", () => ({
  createReadyRecordingOrAdoptRace: jest.fn(),
  stageAndSendRecordingReadyNotifications: (...args: unknown[]) =>
    mockStageReady(...args),
}));
jest.mock("../../lib/stream/recording-decline", () => ({
  wasDeclinedDuringRecording: jest.fn(async () => false),
  discardDeclinedRecording: jest.fn(),
}));
jest.mock("../../lib/stream-logger", () => ({
  streamLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    meeting: { findMany: jest.fn() },
    recording: { findFirst: jest.fn(async () => ({ id: "rec-existing" })) },
  },
}));

import prisma from "../../lib/prisma";
import {
  RecordingService,
  SYNC_PAGE_SIZE,
} from "../../lib/stream/recording-service";

const meeting = (i: number) => ({
  id: `m-${i}`,
  streamCallId: `call-${i}`,
  occurrence: { appointment: { organizationId: null } },
});

describe("user recording sync bounds", () => {
  it("syncs one 30-day page of 25 meetings, ten Stream calls wide, and sends nothing", async () => {
    (prisma.meeting.findMany as jest.Mock).mockResolvedValue(
      Array.from({ length: SYNC_PAGE_SIZE + 1 }, (_, i) => meeting(i)),
    );
    let inFlight = 0;
    let peak = 0;
    const list = jest
      .spyOn(RecordingService, "getCallRecordingsFromStream")
      .mockImplementation(async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        inFlight -= 1;
        return {
          status: "listed",
          recordings: [
            {
              filename: "f.mp4",
              url: "u",
              start_time: new Date(),
              end_time: new Date(),
              session_id: "s",
            },
          ],
        };
      });

    const result = await RecordingService.syncRecordingsForConsultant("cp-1", {
      cursor: "m-prev",
    });

    const query = (prisma.meeting.findMany as jest.Mock).mock.calls[0][0];
    const windowDays =
      (Date.now() - query.where.createdAt.gte.getTime()) / 86_400_000;
    expect(Math.round(windowDays)).toBe(30);
    expect(query).toMatchObject({
      take: SYNC_PAGE_SIZE + 1,
      cursor: { id: "m-prev" },
      skip: 1,
    });
    expect(list).toHaveBeenCalledTimes(SYNC_PAGE_SIZE);
    expect(peak).toBe(10);
    expect(result.nextCursor).toBe(`m-${SYNC_PAGE_SIZE - 1}`);
    expect(result.failed).toBe(0);
    expect(mockStageReady).not.toHaveBeenCalled();
  });

  it("counts sessions Stream did not answer for instead of reporting them as empty", async () => {
    (prisma.meeting.findMany as jest.Mock).mockResolvedValue([
      meeting(0),
      meeting(1),
      meeting(2),
    ]);
    jest
      .spyOn(RecordingService, "getCallRecordingsFromStream")
      .mockImplementation(async (callId: string) =>
        callId === "call-1"
          ? { status: "unavailable", error: "503" }
          : { status: "listed", recordings: [] },
      );

    const result = await RecordingService.syncRecordingsForConsultant("cp-1");

    expect(result.failed).toBe(1);
    expect(result.synced).toBe(0);
  });
});
