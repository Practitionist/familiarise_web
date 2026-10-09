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
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    recordingConsent: { count: jest.fn() },
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
  streamCopyExpiresAt: jest.requireActual("../../lib/stream/recording-utils")
    .streamCopyExpiresAt,
}));

const mockDeleteStreamRecording = jest.fn();
jest.mock("../../lib/stream-client", () => ({
  getStreamVideoClient: () => ({
    video: { call: () => ({ deleteRecording: mockDeleteStreamRecording }) },
  }),
  withStreamCircuitBreaker: (fn: () => unknown) => fn(),
  isExpectedStreamError: () => false,
}));

jest.mock("../../lib/stream/recording-storage", () => ({
  deleteRecordingAssets: jest.fn().mockResolvedValue({ success: true }),
}));

import prisma from "../../lib/prisma";
import {
  handleRecordingStarted,
  handleRecordingReady,
} from "../../lib/stream/recording-handlers";
import { RecordingService } from "../../lib/stream/recording-service";
import { getEventAttendeeIds } from "../../lib/stream/recording-utils";

const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;

const mockMeetingFindUnique = prisma.meeting.findUnique as jest.Mock;
const mockMeetingUpdate = prisma.meeting.update as jest.Mock;
const mockRecordingFindFirst = prisma.recording.findFirst as jest.Mock;
const mockRecordingCreate = prisma.recording.create as jest.Mock;
const mockRecordingUpdateMany = prisma.recording.updateMany as jest.Mock;
const mockRecordingFindMany = prisma.recording.findMany as jest.Mock;
const mockConsentCount = prisma.recordingConsent.count as jest.Mock;
const mockGetEventAttendeeIds = getEventAttendeeIds as jest.Mock;

describe("Stream recording webhook handlers & syncSessionRecordings", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn() as unknown as typeof fetch;
    mockGetEventAttendeeIds.mockResolvedValue([]);
    mockNotifyRecordingAvailable.mockResolvedValue([]);
    mockConsentCount.mockResolvedValue(0);
    mockRecordingUpdateMany.mockResolvedValue({ count: 1 });
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

  it("upgrades a PROCESSING placeholder in place with expiry from end_time and starts no transfer", async () => {
    mockMeetingFindUnique.mockResolvedValue({
      id: "m-1",
      streamCallId: "slot-1",
      isRecording: true,
      occurrence: {
        appointment: {
          organizationId: "org-1",
          subscription: {
            subscriptionPlan: {
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

    expect(mockRecordingUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "rec-placeholder", status: "PROCESSING" },
        data: expect.objectContaining({
          status: "READY",
          durationInMinutes: 30,
          streamRecordingId: "rec-1.mp4",
          streamUrlExpiresAt: new Date(
            new Date("2026-10-03T10:30:00.000Z").getTime() + FOURTEEN_DAYS_MS,
          ),
        }),
      }),
    );
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("stages notifications without Stream's URL when adopting an existing READY recording", async () => {
    mockMeetingFindUnique.mockResolvedValue({
      id: "m-2",
      streamCallId: "slot-2",
      isRecording: false,
      occurrence: {
        appointment: {
          organizationId: "org-2",
          webinar: {
            webinarPlan: {
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

    expect(mockNotifyRecordingAvailable).toHaveBeenCalledWith(
      ["u-att-1", "u-att-2"],
      expect.objectContaining({
        appointmentType: "webinar",
        consultantName: "Dr. Rao",
      }),
      "recording.ready:rec-existing-ready",
      { deferAttempt: true, entityRef: "recording:rec-existing-ready" },
    );
    expect(mockNotifyRecordingAvailable.mock.calls[0][1]).not.toHaveProperty(
      "recordingUrl",
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
  });

  it("discards a 1:1 recording declined before it ended: Stream copy deleted, no playable row", async () => {
    mockMeetingFindUnique.mockResolvedValue({
      id: "m-4",
      streamCallId: "slot-4",
      isRecording: true,
      occurrence: {
        appointment: {
          organizationId: null,
          consultation: { consultationPlan: { consultantProfile: null } },
          subscription: null,
          trial: null,
          webinar: null,
          class: null,
        },
      },
    });
    mockConsentCount.mockResolvedValue(1);
    mockRecordingFindMany.mockResolvedValue([
      { id: "rec-placeholder", status: "PROCESSING", storagePath: null },
    ]);

    await handleRecordingReady({
      type: "call.recording_ready",
      call_cid: "default:slot-4",
      call_recording: {
        filename: "rec-4.mp4",
        url: "https://us-east.stream-io-cdn.com/rec-4.mp4",
        start_time: "2026-10-03T10:00:00.000Z",
        end_time: "2026-10-03T10:30:00.000Z",
        session_id: "sess-4",
      },
      created_at: "2026-10-03T10:31:00.000Z",
    });

    expect(mockConsentCount).toHaveBeenCalledWith({
      where: {
        meetingId: "m-4",
        decision: "DECLINED",
        decidedAt: { lte: new Date("2026-10-03T10:30:00.000Z") },
      },
    });
    expect(mockRecordingUpdateMany).toHaveBeenCalledWith({
      where: { id: "rec-placeholder", status: "PROCESSING" },
      data: { status: "EXPIRED", recordingUrl: "", storagePath: null },
    });
    expect(mockDeleteStreamRecording).toHaveBeenCalledWith({
      session: "sess-4",
      filename: "rec-4.mp4",
    });
    expect(mockRecordingCreate).not.toHaveBeenCalled();
    expect(mockNotifyRecordingAvailable).not.toHaveBeenCalled();
  });

  it("computes streamUrlExpiresAt from end_time and clamps negative durations in syncSessionRecordings", async () => {
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
          session_id: "sess-sync-1",
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
              webinarPlan: { title: "Architecture Sync" },
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
        streamUrlExpiresAt: new Date(endTime.getTime() + FOURTEEN_DAYS_MS),
        organizationId: "org-sync",
      }),
    });
  });
});
