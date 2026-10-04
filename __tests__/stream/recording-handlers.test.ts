/**
 * @jest-environment node
 */

const mockNotifyRecordingAvailable = jest.fn();

jest.mock("../../lib/novu/service", () => ({
  __esModule: true,
  notifyRecordingAvailable: (...args: unknown[]) =>
    mockNotifyRecordingAvailable(...args),
  notifyRecordingFailed: jest.fn(),
  notificationHref: jest.fn().mockReturnValue("/dashboard/recordings"),
  notificationScope: jest.fn().mockReturnValue({}),
}));

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    meeting: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    recording: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
  },
}));

jest.mock("../../lib/stream-logger", () => ({
  streamLogger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

jest.mock("../../lib/stream/recording-utils", () => ({
  generateRecordingTitle: jest.fn().mockReturnValue("Session Recording"),
  getEventAttendeeIds: jest.fn().mockResolvedValue([]),
  getConsultantUserId: jest.fn().mockResolvedValue(null),
}));

jest.mock("../../lib/stream/recording-transfer-service", () => {
  const actual = jest.requireActual(
    "../../lib/stream/recording-transfer-service",
  );
  return {
    ...actual,
    RecordingTransferService: {
      queueRecordingTransfer: jest.fn().mockResolvedValue(undefined),
    },
  };
});

import prisma from "../../lib/prisma";
import {
  handleRecordingStarted,
  handleRecordingReady,
} from "../../lib/stream/recording-handlers";
import { RecordingService } from "../../lib/stream/recording-service";
import { RecordingTransferService } from "../../lib/stream/recording-transfer-service";
import { getEventAttendeeIds } from "../../lib/stream/recording-utils";

const mockMeetingFindUnique = prisma.meeting.findUnique as jest.Mock;
const mockMeetingUpdate = prisma.meeting.update as jest.Mock;
const mockRecordingFindFirst = prisma.recording.findFirst as jest.Mock;
const mockRecordingCreate = prisma.recording.create as jest.Mock;
const mockRecordingUpdate = prisma.recording.update as jest.Mock;
const mockGetEventAttendeeIds = getEventAttendeeIds as jest.Mock;

describe("Stream recording webhook handlers & syncSessionRecordings", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetEventAttendeeIds.mockResolvedValue([]);
    mockNotifyRecordingAvailable.mockResolvedValue([]);
  });

  it("updates meeting recordingStartedAt and recordingStartedBy on call.recording_started", async () => {
    mockMeetingFindUnique.mockResolvedValue({
      id: "m-1",
      streamCallId: "slot-1",
      recordingStartedAt: null,
      recordingStartedBy: null,
    });
    mockMeetingUpdate.mockResolvedValue({ id: "m-1", isRecording: true });

    await handleRecordingStarted({
      type: "call.recording_started",
      call_cid: "default:slot-1",
      user: { id: "user-1", name: "Host" },
      created_at: "2026-10-03T10:00:00.000Z",
    });

    expect(mockMeetingFindUnique).toHaveBeenCalledWith({
      where: { streamCallId: "slot-1" },
    });
    expect(mockMeetingUpdate).toHaveBeenCalledWith({
      where: { id: "m-1" },
      data: {
        isRecording: true,
        recordingStartedAt: new Date("2026-10-03T10:00:00.000Z"),
        recordingStartedBy: "user-1",
      },
    });
  });

  it("upgrades PROCESSING placeholder in place on call.recording_ready and queues transfer for SUPABASE_PERMANENT policy", async () => {
    mockMeetingFindUnique.mockResolvedValue({
      id: "m-1",
      streamCallId: "slot-1",
      isRecording: true,
      occurrence: {
        appointment: {
          organizationId: "org-1",
          subscription: {
            subscriptionPlan: {
              recordingStoragePolicy: "SUPABASE_PERMANENT",
              consultantProfile: { user: { name: "Consultant" } },
            },
          },
          consultation: null,
          trial: null,
          webinar: null,
          class: null,
        },
      },
    });
    mockRecordingFindFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: "rec-placeholder",
      status: "PROCESSING",
      storageType: "STREAM_S3",
    });
    mockRecordingUpdate.mockResolvedValue({
      id: "rec-placeholder",
      status: "READY",
      storageType: "STREAM_S3",
      recordingUrl: "https://us-east.stream-io-cdn.com/rec-1.mp4",
    });

    await handleRecordingReady({
      type: "call.recording_ready",
      call_cid: "default:slot-1",
      call_recording: {
        filename: "rec-1.mp4",
        url: "https://us-east.stream-io-cdn.com/rec-1.mp4",
        start_time: "2026-10-03T10:00:00.000Z",
        end_time: "2026-10-03T10:30:00.000Z",
      },
      created_at: "2026-10-03T10:31:00.000Z",
    });

    expect(mockRecordingUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "rec-placeholder" },
        data: expect.objectContaining({
          status: "READY",
          durationInMinutes: 30,
          streamRecordingId: "rec-1.mp4",
        }),
      }),
    );
    expect(
      RecordingTransferService.queueRecordingTransfer,
    ).toHaveBeenCalledWith("rec-placeholder");
  });

  it("queues transfer and stages notifications with deterministic dedupeKey when adopting an existing READY recording", async () => {
    mockMeetingFindUnique.mockResolvedValue({
      id: "m-2",
      streamCallId: "slot-2",
      isRecording: false,
      occurrence: {
        appointment: {
          organizationId: "org-2",
          webinar: {
            webinarPlan: {
              recordingStoragePolicy: "PERMANENT",
              consultantProfile: { user: { name: "Dr. Rao" } },
            },
          },
          consultation: null,
          subscription: null,
          trial: null,
          class: null,
        },
      },
    });
    mockRecordingFindFirst.mockResolvedValueOnce({
      id: "rec-existing-ready",
      status: "READY",
      storageType: "STREAM_S3",
      recordingUrl: "https://us-east.stream-io-cdn.com/rec-existing.mp4",
    });
    mockGetEventAttendeeIds.mockResolvedValue(["u-att-1", "u-att-2"]);

    await handleRecordingReady({
      type: "call.recording_ready",
      call_cid: "default:slot-2",
      call_recording: {
        filename: "rec-existing.mp4",
        url: "https://us-east.stream-io-cdn.com/rec-existing-replayed.mp4",
        start_time: "2026-10-03T10:00:00.000Z",
        end_time: "2026-10-03T11:00:00.000Z",
      },
      created_at: "2026-10-03T11:01:00.000Z",
    });

    expect(
      RecordingTransferService.queueRecordingTransfer,
    ).toHaveBeenCalledWith("rec-existing-ready");
    expect(mockNotifyRecordingAvailable).toHaveBeenCalledWith(
      ["u-att-1", "u-att-2"],
      expect.objectContaining({
        appointmentType: "webinar",
        consultantName: "Dr. Rao",
      }),
      "recording.ready:rec-existing-ready",
      { deferAttempt: true, entityRef: "recording:rec-existing-ready" },
    );
  });

  it("propagates outbox staging errors and recovers from P2002 concurrent create races", async () => {
    mockMeetingFindUnique.mockResolvedValue({
      id: "m-3",
      streamCallId: "slot-3",
      isRecording: false,
      occurrence: {
        appointment: {
          organizationId: null,
          webinar: {
            webinarPlan: {
              recordingStoragePolicy: "PERMANENT",
              consultantProfile: { user: { name: "Host" } },
            },
          },
          consultation: null,
          subscription: null,
          trial: null,
          class: null,
        },
      },
    });
    mockRecordingFindFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: "rec-raced",
        status: "READY",
        storageType: "STREAM_S3",
        recordingUrl: "https://us-east.stream-io-cdn.com/rec-raced.mp4",
      });
    mockRecordingCreate.mockRejectedValueOnce(
      Object.assign(new Error("Unique constraint failed"), { code: "P2002" }),
    );
    mockGetEventAttendeeIds.mockResolvedValue(["u-att-1"]);
    mockNotifyRecordingAvailable.mockRejectedValueOnce(
      new Error("Outbox DB unavailable"),
    );

    await expect(
      handleRecordingReady({
        type: "call.recording_ready",
        call_cid: "default:slot-3",
        call_recording: {
          filename: "rec-raced.mp4",
          url: "https://us-east.stream-io-cdn.com/rec-raced.mp4",
          start_time: "2026-10-03T10:00:00.000Z",
          end_time: "2026-10-03T11:00:00.000Z",
        },
        created_at: "2026-10-03T11:01:00.000Z",
      }),
    ).rejects.toThrow("Outbox DB unavailable");

    expect(
      RecordingTransferService.queueRecordingTransfer,
    ).toHaveBeenCalledWith("rec-raced");
  });

  it("computes streamUrlExpiresAt from end_time, clamps negative durations, and queues transfer for PERMANENT policy in syncSessionRecordings", async () => {
    const endTime = new Date("2026-09-20T12:00:00.000Z");
    const startTime = new Date("2026-09-20T13:00:00.000Z"); // inverted timestamps to test >= 0 clamp
    jest
      .spyOn(RecordingService, "getCallRecordingsFromStream")
      .mockResolvedValueOnce([
        {
          filename: "synced-rec-1.mp4",
          url: "https://us-east.stream-io-cdn.com/synced-rec-1.mp4",
          start_time: startTime,
          end_time: endTime,
        },
      ]);
    mockRecordingFindFirst.mockResolvedValueOnce(null);
    mockRecordingCreate.mockImplementation(async ({ data }) => ({
      id: "rec-synced-1",
      ...data,
    }));

    const synced: unknown[] = [];
    const outcome = await RecordingService.syncSessionRecordings(
      {
        id: "m-sync-1",
        streamCallId: "call-sync-1",
        occurrence: {
          appointment: {
            organizationId: "org-sync",
            webinar: {
              webinarPlan: {
                title: "Architecture Sync",
                recordingStoragePolicy: "PERMANENT",
              },
            },
          } as never,
        },
      },
      synced as never,
    );

    expect(outcome).toEqual({ ok: true });
    expect(mockRecordingCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        durationInMinutes: 0,
        streamUrlExpiresAt: new Date(
          endTime.getTime() + 14 * 24 * 60 * 60 * 1000,
        ),
        organizationId: "org-sync",
      }),
    });
    expect(
      RecordingTransferService.queueRecordingTransfer,
    ).toHaveBeenCalledWith("rec-synced-1");
  });
});
