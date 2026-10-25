/**
 * @jest-environment node
 */

const mockNotifyRecordingAvailable = jest.fn();
const mockNotifyRecordingFailed = jest.fn();

jest.mock("../../lib/novu/service", () => ({
  __esModule: true,
  notifyRecordingAvailable: (...args: unknown[]) =>
    mockNotifyRecordingAvailable(...args),
  notifyRecordingFailed: (...args: unknown[]) =>
    mockNotifyRecordingFailed(...args),
  notificationHref: jest.fn().mockReturnValue("/dashboard/recordings"),
  notificationScope: jest.fn().mockReturnValue({}),
}));

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    meeting: {
      findUnique: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    recording: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      updateManyAndReturn: jest.fn(),
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

const mockStageEmailOnce = jest.fn();
jest.mock("../../lib/email/senders/booking", () => ({
  stageDocumentAndRecordingEmailOnce: (...args: unknown[]) =>
    mockStageEmailOnce(...args),
}));

jest.mock("../../lib/stream/recording-storage", () => ({
  deleteRecordingAssets: jest.fn().mockResolvedValue({ success: true }),
}));

const mockDeleteStreamRecordingCopy = jest.fn().mockResolvedValue({
  success: true,
});
jest.mock("../../lib/stream/recording-stream-delete", () => ({
  deleteStreamRecordingCopy: (...args: unknown[]) =>
    mockDeleteStreamRecordingCopy(...args),
}));

import prisma from "../../lib/prisma";
import { deleteRecordingAssets } from "../../lib/stream/recording-storage";
import {
  handleRecordingFailed,
  handleRecordingStarted,
  handleRecordingStopped,
  handleRecordingReady,
  stageAndSendRecordingReadyNotifications,
} from "../../lib/stream/recording-handlers";
import { RecordingService } from "../../lib/stream/recording-service";
import { getEventAttendeeIds } from "../../lib/stream/recording-utils";

const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;

const mockMeetingFindUnique = prisma.meeting.findUnique as jest.Mock;
const mockMeetingUpdateMany = prisma.meeting.updateMany as jest.Mock;
const mockRecordingFindFirst = prisma.recording.findFirst as jest.Mock;
const mockRecordingFindUnique = prisma.recording.findUnique as jest.Mock;
const mockRecordingCreate = prisma.recording.create as jest.Mock;
const mockRecordingUpdateMany = prisma.recording.updateMany as jest.Mock;
const mockRecordingFindMany = prisma.recording.findMany as jest.Mock;
const mockRecordingUpdateManyAndReturn = prisma.recording
  .updateManyAndReturn as jest.Mock;
const mockDeleteRecordingAssets = deleteRecordingAssets as jest.Mock;
const mockConsentCount = prisma.recordingConsent.count as jest.Mock;
const mockGetEventAttendeeIds = getEventAttendeeIds as jest.Mock;

describe("Stream recording webhook handlers & syncSessionRecordings", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Unconsumed once-values must not leak into the next test's lookups.
    mockRecordingFindFirst.mockReset();
    global.fetch = jest.fn() as unknown as typeof fetch;
    mockGetEventAttendeeIds.mockResolvedValue([]);
    mockNotifyRecordingAvailable.mockResolvedValue([]);
    mockConsentCount.mockResolvedValue(0);
    mockMeetingUpdateMany.mockResolvedValue({ count: 1 });
    mockRecordingUpdateMany.mockResolvedValue({ count: 1 });
    mockRecordingUpdateManyAndReturn.mockImplementation(
      async ({ where, data }: { where: { id: string }; data: object }) => [
        { id: where.id, ...data },
      ],
    );
    mockDeleteRecordingAssets.mockResolvedValue({ success: true });
    mockStageEmailOnce.mockResolvedValue([]);
    mockRecordingFindUnique.mockResolvedValue({
      status: "READY",
      removedAt: null,
    });
  });

  it("updates meeting recordingStartedAt and recordingStartedBy on call.recording_started", async () => {
    mockMeetingFindUnique.mockResolvedValue({
      id: "m-1",
      streamCallId: "slot-1",
      recordingStartedAt: null,
      recordingStartedBy: null,
    });
    mockMeetingUpdateMany.mockResolvedValueOnce({ count: 1 });

    await handleRecordingStarted({
      type: "call.recording_started",
      call_cid: "default:slot-1",
      user: { id: "user-1", name: "Host" },
      created_at: "2026-10-03T10:00:00.000Z",
    });

    expect(mockMeetingFindUnique).toHaveBeenCalledWith({
      where: { streamCallId: "slot-1" },
    });
    expect(mockMeetingUpdateMany).toHaveBeenCalledWith({
      where: { id: "m-1", streamCallId: "slot-1", endedAt: null },
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
    // By filename, then the erased-row lookup, then the placeholder.
    mockRecordingFindFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
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

    expect(mockRecordingUpdateManyAndReturn).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "rec-placeholder",
          status: { in: ["RECORDING", "PROCESSING", "FAILED"] },
        },
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

  it("keeps a recording erased before Stream named its file removed, deleting Stream's copy", async () => {
    mockMeetingFindUnique.mockResolvedValue({
      id: "m-1",
      streamCallId: "slot-1",
      isRecording: false,
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
    mockGetEventAttendeeIds.mockResolvedValue(["u-att-1"]);
    // No row has the file yet; the erased FAILED placeholder absorbs it.
    mockRecordingFindFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "rec-erased" });

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

    expect(mockRecordingUpdateManyAndReturn).toHaveBeenCalledTimes(1);
    expect(mockRecordingUpdateManyAndReturn).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "rec-erased",
          status: "EXPIRED",
          streamRecordingId: null,
          removedAt: { not: null },
        }),
        data: expect.objectContaining({ streamRecordingId: "rec-1.mp4" }),
      }),
    );
    expect(mockDeleteStreamRecordingCopy).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "rec-erased",
        streamRecordingId: "rec-1.mp4",
      }),
    );
    expect(mockRecordingCreate).not.toHaveBeenCalled();
    expect(mockNotifyRecordingAvailable).not.toHaveBeenCalled();
  });

  it("throws, notifying nobody, when the placeholder left the pre-READY states before the CAS", async () => {
    mockMeetingFindUnique.mockResolvedValue({
      id: "m-1",
      streamCallId: "slot-1",
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
    mockRecordingFindFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: "rec-placeholder",
        status: "RECORDING",
        storageType: "STREAM_S3",
      });
    mockRecordingUpdateMany.mockResolvedValue({ count: 0 });
    mockRecordingUpdateManyAndReturn.mockResolvedValue([]);
    mockGetEventAttendeeIds.mockResolvedValue(["u-att-1"]);

    await expect(
      handleRecordingReady({
        type: "call.recording_ready",
        call_cid: "default:slot-1",
        call_recording: {
          filename: "rec-1.mp4",
          url: "https://us-east.stream-io-cdn.com/rec-1.mp4",
          start_time: "2026-10-03T10:00:00.000Z",
          end_time: "2026-10-03T10:30:00.000Z",
        },
        created_at: "2026-10-03T10:31:00.000Z",
      }),
    ).rejects.toThrow("changed while marking it ready");
    expect(mockNotifyRecordingAvailable).not.toHaveBeenCalled();
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
    // By filename, erased-row lookup, placeholder lookup, then the raced row.
    mockRecordingFindFirst
      .mockResolvedValueOnce(null)
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
    mockRecordingUpdateManyAndReturn.mockResolvedValueOnce([
      {
        id: "rec-placeholder",
        storagePath: null,
        previewClipStoragePath: null,
        thumbnailUrl: null,
        streamCallId: null,
        streamRecordingId: null,
      },
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
    expect(mockRecordingUpdateManyAndReturn).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          meetingId: "m-4",
          status: { not: "EXPIRED" },
        }),
        data: expect.objectContaining({
          status: "EXPIRED",
          recordingUrl: "",
          removalReason: "DECLINED",
        }),
      }),
    );
    // The filename lands on the expired placeholder, so expire-recordings can retry the delete.
    expect(mockRecordingUpdateManyAndReturn).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "rec-placeholder",
          status: "EXPIRED",
          streamRecordingId: null,
        },
        data: { streamRecordingId: "rec-4.mp4", streamCallId: "slot-4" },
      }),
    );
    expect(mockDeleteStreamRecordingCopy).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "rec-placeholder",
        streamCallId: "slot-4",
        streamRecordingId: "rec-4.mp4",
      }),
    );
    expect(mockDeleteStreamRecording).not.toHaveBeenCalled();
    expect(mockRecordingCreate).not.toHaveBeenCalled();
    expect(mockNotifyRecordingAvailable).not.toHaveBeenCalled();
  });

  it("expires a declined copied recording before deleting its assets, then clears every media pointer", async () => {
    mockMeetingFindUnique.mockResolvedValue({
      id: "m-5",
      streamCallId: "slot-5",
      isRecording: false,
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
      {
        id: "rec-copied",
        status: "AVAILABLE",
        storagePath: "recordings/rec-copied/a.mp4",
      },
    ]);
    mockRecordingUpdateManyAndReturn.mockResolvedValue([
      {
        id: "rec-copied",
        storagePath: "recordings/rec-copied/a.mp4",
        previewClipStoragePath: "rec-copied/clip.mp4",
        thumbnailUrl: "https://cdn.example/thumb.jpg",
        streamCallId: "slot-5",
        streamRecordingId: "rec-5.mp4",
      },
    ]);

    await handleRecordingReady({
      type: "call.recording_ready",
      call_cid: "default:slot-5",
      call_recording: {
        filename: "rec-5.mp4",
        url: "https://us-east.stream-io-cdn.com/rec-5.mp4",
        start_time: "2026-10-03T10:00:00.000Z",
        end_time: "2026-10-03T10:30:00.000Z",
        session_id: "sess-5",
      },
      created_at: "2026-10-03T10:31:00.000Z",
    });

    expect(mockRecordingUpdateManyAndReturn).toHaveBeenCalled();
    expect(mockDeleteRecordingAssets).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "rec-copied",
        storagePath: "recordings/rec-copied/a.mp4",
      }),
      expect.objectContaining({ add: expect.any(Function) }),
    );
    expect(mockDeleteStreamRecordingCopy).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "rec-copied",
        storagePath: "recordings/rec-copied/a.mp4",
        streamCallId: "slot-5",
        streamRecordingId: "rec-5.mp4",
      }),
    );
    expect(
      mockRecordingUpdateManyAndReturn.mock.invocationCallOrder[0],
    ).toBeLessThan(mockDeleteRecordingAssets.mock.invocationCallOrder[0]);
    expect(mockRecordingUpdateMany).toHaveBeenCalledWith({
      where: { id: "rec-copied", status: "EXPIRED" },
      data: {
        storagePath: null,
        previewClipUrl: null,
        previewClipStoragePath: null,
        previewClipDuration: null,
        previewTranscript: null,
        thumbnailUrl: null,
        streamRecordingId: null,
      },
    });
  });

  it("computes streamUrlExpiresAt from end_time and clamps negative durations in syncSessionRecordings", async () => {
    const endTime = new Date("2026-09-20T12:00:00.000Z");
    const startTime = new Date("2026-09-20T13:00:00.000Z"); // inverted timestamps to test >= 0 clamp
    jest
      .spyOn(RecordingService, "getCallRecordingsFromStream")
      .mockResolvedValueOnce({
        status: "listed",
        recordings: [
          {
            filename: "synced-rec-1.mp4",
            url: "https://us-east.stream-io-cdn.com/synced-rec-1.mp4",
            start_time: startTime,
            end_time: endTime,
            session_id: "sess-sync-1",
          },
        ],
      });
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

  it("does not re-arm isRecording when call.ended raced ahead before write time (CAS count === 0)", async () => {
    mockMeetingFindUnique.mockResolvedValue({
      id: "m-ended",
      streamCallId: "slot-ended",
      endedAt: null,
      recordingStartedAt: null,
      recordingStartedBy: null,
    });
    mockMeetingUpdateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });

    await handleRecordingStarted({
      type: "call.recording_started",
      call_cid: "default:slot-ended",
      user: { id: "host-1" },
      created_at: "2026-10-03T10:00:00.000Z",
    });

    expect(mockMeetingUpdateMany).toHaveBeenNthCalledWith(1, {
      where: { id: "m-ended", streamCallId: "slot-ended", endedAt: null },
      data: {
        isRecording: true,
        recordingStartedAt: new Date("2026-10-03T10:00:00.000Z"),
        recordingStartedBy: "host-1",
      },
    });
    expect(mockMeetingUpdateMany).toHaveBeenNthCalledWith(2, {
      where: { id: "m-ended" },
      data: {
        recordingStartedAt: new Date("2026-10-03T10:00:00.000Z"),
        recordingStartedBy: "host-1",
      },
    });
    expect(mockMeetingUpdateMany.mock.calls[1][0].data).not.toHaveProperty(
      "isRecording",
    );
  });

  it("dead-letters a recording_ready for an unknown meeting instead of retrying it", async () => {
    mockMeetingFindUnique.mockResolvedValue(null);

    await expect(
      handleRecordingReady({
        type: "call.recording_ready",
        call_cid: "default:slot-missing",
        call_recording: {
          filename: "rec-missing.mp4",
          url: "https://us-east.stream-io-cdn.com/rec-missing.mp4",
          start_time: "2026-10-03T10:00:00.000Z",
          end_time: "2026-10-03T10:30:00.000Z",
        },
        created_at: "2026-10-03T10:31:00.000Z",
      }),
    ).rejects.toThrow(/^permanent: recording_ready for unknown meeting/);
  });

  it("re-stages ready notices for an existing row only when the reconciler asks", async () => {
    jest
      .spyOn(RecordingService, "getCallRecordingsFromStream")
      .mockResolvedValueOnce({
        status: "listed",
        recordings: [
          {
            filename: "existing-rec.mp4",
            url: "https://us-east.stream-io-cdn.com/existing-rec.mp4",
            start_time: new Date("2026-09-20T10:00:00.000Z"),
            end_time: new Date("2026-09-20T11:00:00.000Z"),
            session_id: "sess-existing",
          },
        ],
      });
    mockRecordingFindFirst.mockResolvedValueOnce({
      id: "rec-already-persisted",
      status: "READY",
      storageType: "STREAM_S3",
      recordingUrl: "https://us-east.stream-io-cdn.com/existing-rec.mp4",
    });
    mockGetEventAttendeeIds.mockResolvedValueOnce(["attendee-existing"]);

    const synced: unknown[] = [];
    const outcome = await RecordingService.syncSessionRecordings(
      {
        id: "m-existing",
        streamCallId: "call-existing",
        occurrence: {
          appointment: {
            organizationId: "org-1",
            webinar: { webinarPlan: { title: "Retryable Notify" } },
          } as never,
        },
      },
      synced as never,
      { notify: true },
    );

    expect(outcome).toEqual({ ok: true });
    expect(synced).toHaveLength(0);
    expect(mockNotifyRecordingAvailable).toHaveBeenCalledWith(
      ["attendee-existing"],
      expect.any(Object),
      "recording.ready:rec-already-persisted",
      { deferAttempt: true, entityRef: "recording:rec-already-persisted" },
    );
  });

  it("adopts P2002 concurrent create races across multi-segment sync and stages recording-ready notifications", async () => {
    const start1 = new Date("2026-09-20T10:00:00.000Z");
    const end1 = new Date("2026-09-20T11:00:00.000Z");
    const start2 = new Date("2026-09-20T11:05:00.000Z");
    const end2 = new Date("2026-09-20T12:00:00.000Z");

    jest
      .spyOn(RecordingService, "getCallRecordingsFromStream")
      .mockResolvedValueOnce({
        status: "listed",
        recordings: [
          {
            filename: "seg-1.mp4",
            url: "https://us-east.stream-io-cdn.com/seg-1.mp4",
            start_time: start1,
            end_time: end1,
            session_id: "sess-multi",
          },
          {
            filename: "seg-2.mp4",
            url: "https://us-east.stream-io-cdn.com/seg-2.mp4",
            start_time: start2,
            end_time: end2,
            session_id: "sess-multi",
          },
        ],
      });

    // Each segment: by filename, then the erased-row lookup; seg-1 then adopts its race.
    mockRecordingFindFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: "rec-seg-1",
        status: "READY",
        storageType: "STREAM_S3",
        recordingUrl: "https://us-east.stream-io-cdn.com/seg-1.mp4",
      })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);

    mockRecordingCreate
      .mockRejectedValueOnce(
        Object.assign(new Error("Unique constraint failed"), { code: "P2002" }),
      )
      .mockImplementationOnce(async ({ data }) => ({
        id: "rec-seg-2",
        ...data,
      }));

    mockGetEventAttendeeIds.mockResolvedValue(["attendee-1"]);

    const synced: unknown[] = [];
    const outcome = await RecordingService.syncSessionRecordings(
      {
        id: "m-sync-multi",
        streamCallId: "call-sync-multi",
        occurrence: {
          appointment: {
            organizationId: "org-sync",
            trial: {
              subscriptionPlan: { title: "Trial Cohort" },
            },
          } as never,
        },
      },
      synced as never,
      { notify: true },
    );

    expect(outcome).toEqual({ ok: true });
    expect(synced).toHaveLength(2);
    expect(mockNotifyRecordingAvailable).toHaveBeenCalledTimes(2);
    expect(mockNotifyRecordingAvailable).toHaveBeenCalledWith(
      ["attendee-1"],
      expect.any(Object),
      "recording.ready:rec-seg-2",
      { deferAttempt: true, entityRef: "recording:rec-seg-2" },
    );
  });

  describe("segment and call-rotation races", () => {
    const readyEvent = (callCid: string, endTime: string) => ({
      type: "call.recording_ready" as const,
      call_cid: callCid,
      call_recording: {
        filename: "seg-1.mp4",
        url: "https://us-east.stream-io-cdn.com/seg-1.mp4",
        start_time: "2026-10-03T10:00:00.000Z",
        end_time: endTime,
      },
      created_at: endTime,
    });
    const liveMeeting = (streamCallId: string) => ({
      id: "m-seg",
      streamCallId,
      isRecording: true,
      recordingStartedAt: new Date("2026-10-03T10:40:00.000Z"),
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

    it("a delayed stop clears the flag only for a segment that began before it", async () => {
      mockMeetingFindUnique.mockResolvedValue(liveMeeting("occurrence-1"));
      mockMeetingUpdateMany.mockResolvedValueOnce({ count: 0 });

      await handleRecordingStopped({
        type: "call.recording_stopped",
        call_cid: "default:occurrence-1",
        created_at: "2026-10-03T10:30:00.000Z",
      });

      expect(mockMeetingUpdateMany).toHaveBeenCalledWith({
        where: {
          id: "m-seg",
          streamCallId: "occurrence-1",
          OR: [
            { recordingStartedAt: null },
            {
              recordingStartedAt: {
                lte: new Date("2026-10-03T10:30:00.000Z"),
              },
            },
          ],
        },
        data: { isRecording: false },
      });
      expect(prisma.meeting.update).not.toHaveBeenCalled();
      expect(mockRecordingUpdateMany).not.toHaveBeenCalled();
    });

    it("a ready for a rotated call clears only a flag still held by that call", async () => {
      mockMeetingFindUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(liveMeeting("occurrence-1-rabc"));
      mockRecordingFindFirst.mockResolvedValue(null);
      mockRecordingCreate.mockResolvedValue({ id: "rec-seg-1" });

      await handleRecordingReady(
        readyEvent("default:occurrence-1", "2026-10-03T10:30:00.000Z"),
      );

      expect(mockMeetingFindUnique).toHaveBeenLastCalledWith(
        expect.objectContaining({
          where: { appointmentOccurrenceId: "1" },
        }),
      );
      expect(prisma.meeting.update).not.toHaveBeenCalled();
      expect(mockMeetingUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ streamCallId: "occurrence-1" }),
          data: { isRecording: false },
        }),
      );
    });

    it("a late started event for a rotated call resolves the meeting but leaves its flag", async () => {
      mockMeetingFindUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(liveMeeting("occurrence-1-rabc"));

      await handleRecordingStarted({
        type: "call.recording_started",
        call_cid: "default:occurrence-1",
        created_at: "2026-10-03T10:00:00.000Z",
      });

      expect(mockMeetingFindUnique).toHaveBeenLastCalledWith({
        where: { appointmentOccurrenceId: "1" },
      });
      expect(mockMeetingUpdateMany).not.toHaveBeenCalled();
    });

    it("a started event for the current call arms the flag after the occurrence lookup", async () => {
      mockMeetingFindUnique.mockResolvedValueOnce({
        ...liveMeeting("occurrence-1"),
        recordingStartedAt: null,
        recordingStartedBy: null,
      });

      await handleRecordingStarted({
        type: "call.recording_started",
        call_cid: "default:occurrence-1",
        created_at: "2026-10-03T10:00:00.000Z",
      });

      expect(mockMeetingUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "m-seg", streamCallId: "occurrence-1", endedAt: null },
          data: expect.objectContaining({ isRecording: true }),
        }),
      );
    });
  });

  describe("out-of-order ready and call ended", () => {
    const meeting = (
      overrides: { isRecording?: boolean; endedAt?: Date | null } = {},
    ) => ({
      id: "m-ooo",
      streamCallId: "slot-ooo",
      isRecording: false,
      endedAt: null as Date | null,
      occurrence: {
        appointment: {
          id: "appt-ooo",
          organizationId: null,
          consultation: { consultationPlan: { consultantProfile: null } },
          subscription: null,
          trial: null,
          webinar: null,
          class: null,
        },
      },
      ...overrides,
    });

    const readyEvent = (
      filename: string,
      startTime: string,
      endTime: string,
    ) => ({
      type: "call.recording_ready" as const,
      call_cid: "default:slot-ooo",
      call_recording: {
        filename,
        url: `https://us-east.stream-io-cdn.com/${filename}`,
        start_time: startTime,
        end_time: endTime,
      },
      created_at: endTime,
    });

    type StoredRecording = {
      id: string;
      status: string;
      streamRecordingId: string;
      recordingUrl?: string;
    } & Record<string, unknown>;

    const createdRecording = (
      filename: string,
      startTime: string,
      endTime: string,
    ) => {
      const start = new Date(startTime);
      const end = new Date(endTime);
      return {
        title: "Session Recording",
        recordingUrl: `https://us-east.stream-io-cdn.com/${filename}`,
        durationInMinutes: Math.round(
          (end.getTime() - start.getTime()) / (1000 * 60),
        ),
        recordedAt: start,
        streamRecordingId: filename,
        streamCallId: "slot-ooo",
        storageType: "STREAM_S3",
        status: "READY",
        streamUrlExpiresAt: new Date(end.getTime() + FOURTEEN_DAYS_MS),
        meetingId: "m-ooo",
        organizationId: null,
      };
    };

    const useRecordingRows = () => {
      const rows: StoredRecording[] = [];
      mockRecordingFindFirst.mockImplementation(
        async (args: {
          where: {
            streamRecordingId?: string;
            status?: { in?: string[] };
          };
        }) => {
          const { where } = args;
          if (where.streamRecordingId) {
            return (
              rows.find(
                (row) => row.streamRecordingId === where.streamRecordingId,
              ) ?? null
            );
          }
          if (where.status?.in) {
            const statuses = where.status.in;
            return rows.find((row) => statuses.includes(row.status)) ?? null;
          }
          return rows[rows.length - 1] ?? null;
        },
      );
      mockRecordingCreate.mockImplementation(
        async (args: { data: Record<string, unknown> }) => {
          const row = {
            id: `rec-${String(args.data.streamRecordingId)}`,
            ...args.data,
          } as unknown as StoredRecording;
          rows.push(row);
          return row;
        },
      );
      return rows;
    };

    afterEach(() => {
      mockMeetingFindUnique.mockReset();
      mockRecordingFindFirst.mockReset();
      mockRecordingCreate.mockReset();
    });

    it("creates a READY row when the ready event arrives before call.ended", async () => {
      mockMeetingFindUnique.mockResolvedValue(
        meeting({ isRecording: true, endedAt: null }),
      );
      const rows = useRecordingRows();

      await handleRecordingReady(
        readyEvent(
          "seg-before-end.mp4",
          "2026-10-03T10:00:00.000Z",
          "2026-10-03T10:30:00.000Z",
        ),
      );

      expect(mockRecordingCreate).toHaveBeenCalledTimes(1);
      expect(mockRecordingCreate).toHaveBeenCalledWith({
        data: createdRecording(
          "seg-before-end.mp4",
          "2026-10-03T10:00:00.000Z",
          "2026-10-03T10:30:00.000Z",
        ),
      });
      expect(rows).toHaveLength(1);
      expect(mockRecordingUpdateManyAndReturn).not.toHaveBeenCalled();
      expect(mockMeetingUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: { isRecording: false } }),
      );
    });

    it("still creates a READY row when call.ended arrived first", async () => {
      mockMeetingFindUnique.mockResolvedValue(
        meeting({
          isRecording: false,
          endedAt: new Date("2026-10-03T10:45:00.000Z"),
        }),
      );
      useRecordingRows();
      mockGetEventAttendeeIds.mockResolvedValue(["u-att-1"]);

      await handleRecordingReady(
        readyEvent(
          "seg-after-end.mp4",
          "2026-10-03T10:00:00.000Z",
          "2026-10-03T10:30:00.000Z",
        ),
      );

      expect(mockRecordingCreate).toHaveBeenCalledTimes(1);
      expect(mockRecordingCreate).toHaveBeenCalledWith({
        data: createdRecording(
          "seg-after-end.mp4",
          "2026-10-03T10:00:00.000Z",
          "2026-10-03T10:30:00.000Z",
        ),
      });
      expect(mockRecordingUpdateManyAndReturn).not.toHaveBeenCalled();
      expect(mockMeetingUpdateMany).not.toHaveBeenCalled();
      expect(mockNotifyRecordingAvailable).toHaveBeenCalledWith(
        ["u-att-1"],
        expect.any(Object),
        "recording.ready:rec-seg-after-end.mp4",
        expect.objectContaining({
          entityRef: "recording:rec-seg-after-end.mp4",
        }),
      );
      expect(mockStageEmailOnce).toHaveBeenCalledWith(
        expect.objectContaining({
          entityId: "rec-seg-after-end.mp4",
          userIds: ["u-att-1"],
          kind: "RECORDING_READY",
        }),
        expect.objectContaining({ scope: "stream.recording-ready" }),
      );
    });

    it("adopts a duplicate ready for the same filename instead of creating a second row", async () => {
      mockMeetingFindUnique.mockResolvedValue(
        meeting({ endedAt: new Date("2026-10-03T10:45:00.000Z") }),
      );
      const rows = useRecordingRows();
      mockGetEventAttendeeIds.mockResolvedValue(["u-att-1"]);

      const event = readyEvent(
        "seg-dup.mp4",
        "2026-10-03T10:00:00.000Z",
        "2026-10-03T10:30:00.000Z",
      );
      await handleRecordingReady(event);
      await handleRecordingReady(event);

      expect(mockRecordingCreate).toHaveBeenCalledTimes(1);
      expect(mockRecordingCreate).toHaveBeenCalledWith({
        data: createdRecording(
          "seg-dup.mp4",
          "2026-10-03T10:00:00.000Z",
          "2026-10-03T10:30:00.000Z",
        ),
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: "rec-seg-dup.mp4",
        status: "READY",
        recordingUrl: "https://us-east.stream-io-cdn.com/seg-dup.mp4",
      });
      expect(mockRecordingUpdateManyAndReturn).not.toHaveBeenCalled();
      expect(mockRecordingFindFirst).toHaveBeenCalledWith({
        where: { meetingId: "m-ooo", streamRecordingId: "seg-dup.mp4" },
      });
      const bellKeys = mockNotifyRecordingAvailable.mock.calls.map(
        (call) => call[2],
      );
      expect(bellKeys.length).toBeGreaterThan(0);
      expect(new Set(bellKeys)).toEqual(
        new Set(["recording.ready:rec-seg-dup.mp4"]),
      );
      const emailKeys = mockStageEmailOnce.mock.calls.map((call) =>
        (call[1] as { key: (userId: string) => string }).key("u-att-1"),
      );
      expect(emailKeys.length).toBeGreaterThan(0);
      expect(new Set(emailKeys)).toEqual(
        new Set(["recording-ready:rec-seg-dup.mp4:u-att-1"]),
      );
    });

    it("stores both segments when the later segment is delivered first", async () => {
      mockMeetingFindUnique.mockResolvedValue(
        meeting({ endedAt: new Date("2026-10-03T12:05:00.000Z") }),
      );
      useRecordingRows();
      mockGetEventAttendeeIds.mockResolvedValue(["u-att-1"]);

      await handleRecordingReady(
        readyEvent(
          "seg-2.mp4",
          "2026-10-03T11:05:00.000Z",
          "2026-10-03T12:00:00.000Z",
        ),
      );
      await handleRecordingReady(
        readyEvent(
          "seg-1.mp4",
          "2026-10-03T10:00:00.000Z",
          "2026-10-03T11:00:00.000Z",
        ),
      );

      expect(mockRecordingCreate).toHaveBeenCalledTimes(2);
      const created = new Map(
        mockRecordingCreate.mock.calls.map(([args]) => [
          args.data.streamRecordingId as string,
          args.data as ReturnType<typeof createdRecording>,
        ]),
      );
      expect(created.get("seg-2.mp4")).toEqual(
        createdRecording(
          "seg-2.mp4",
          "2026-10-03T11:05:00.000Z",
          "2026-10-03T12:00:00.000Z",
        ),
      );
      expect(created.get("seg-1.mp4")).toEqual(
        createdRecording(
          "seg-1.mp4",
          "2026-10-03T10:00:00.000Z",
          "2026-10-03T11:00:00.000Z",
        ),
      );
      expect(mockRecordingUpdateManyAndReturn).not.toHaveBeenCalled();
      const bellKeys = mockNotifyRecordingAvailable.mock.calls.map(
        (call) => call[2],
      );
      expect(new Set(bellKeys)).toEqual(
        new Set([
          "recording.ready:rec-seg-2.mp4",
          "recording.ready:rec-seg-1.mp4",
        ]),
      );
    });
  });

  it("never announces a ready event for an EXPIRED recording", async () => {
    mockMeetingFindUnique.mockResolvedValue({
      id: "m-exp",
      streamCallId: "slot-exp",
      isRecording: false,
      occurrence: {
        appointment: {
          organizationId: null,
          webinar: { webinarPlan: { consultantProfile: null } },
          consultation: null,
          subscription: null,
          trial: null,
          class: null,
        },
      },
    });
    mockRecordingFindFirst.mockResolvedValueOnce({
      id: "rec-expired",
      status: "EXPIRED",
      storageType: "STREAM_S3",
    });
    mockRecordingFindUnique.mockResolvedValue({
      status: "EXPIRED",
      removedAt: new Date(),
    });
    mockGetEventAttendeeIds.mockResolvedValue(["u-1"]);

    await handleRecordingReady({
      type: "call.recording_ready",
      call_cid: "default:slot-exp",
      call_recording: {
        filename: "rec-expired.mp4",
        url: "https://us-east.stream-io-cdn.com/rec-expired.mp4",
        start_time: "2026-10-03T10:00:00.000Z",
        end_time: "2026-10-03T11:00:00.000Z",
      },
      created_at: "2026-10-03T11:01:00.000Z",
    });

    expect(mockNotifyRecordingAvailable).not.toHaveBeenCalled();
    expect(mockStageEmailOnce).not.toHaveBeenCalled();
  });

  it("keys recording-failed bells and emails on the FAILED row, per recipient", async () => {
    mockMeetingFindUnique.mockResolvedValue({
      id: "m-fail",
      streamCallId: "slot-fail",
      occurrence: { appointment: { organizationId: null } },
    });
    mockRecordingFindFirst.mockResolvedValueOnce({ id: "rec-failed" });
    mockGetEventAttendeeIds.mockResolvedValue(["u-1"]);
    mockNotifyRecordingFailed.mockResolvedValue({});

    await handleRecordingFailed({
      type: "call.recording_failed",
      call_cid: "default:slot-fail",
      egress_id: "eg-1",
      recording_type: "composite",
      created_at: "2026-10-03T11:01:00.000Z",
    });

    expect(mockNotifyRecordingFailed).toHaveBeenCalledWith(
      "u-1",
      expect.any(Object),
      "recording.failed:rec-failed",
      { deferAttempt: true },
    );
    const claim = mockStageEmailOnce.mock.calls[0][1];
    expect(claim.scope).toBe("stream.recording-failed");
    expect(claim.key("u-1")).toBe("recording-failed:rec-failed:u-1");
  });

  it("keys the ready email claim on the recording and the recipient", async () => {
    mockGetEventAttendeeIds.mockResolvedValue(["u-1"]);
    await stageAndSendRecordingReadyNotifications(
      { organizationId: null } as never,
      "rec-9",
    );

    const claim = mockStageEmailOnce.mock.calls[0][1];
    expect(claim.scope).toBe("stream.recording-ready");
    expect(claim.key("u-1")).toBe("recording-ready:rec-9:u-1");
  });

  it("a user sync mirrors rows without sending any notice", async () => {
    jest
      .spyOn(RecordingService, "getCallRecordingsFromStream")
      .mockResolvedValueOnce({
        status: "listed",
        recordings: [
          {
            filename: "quiet.mp4",
            url: "https://us-east.stream-io-cdn.com/quiet.mp4",
            start_time: new Date("2026-09-20T10:00:00.000Z"),
            end_time: new Date("2026-09-20T11:00:00.000Z"),
            session_id: "sess-quiet",
          },
        ],
      });
    mockRecordingFindFirst.mockResolvedValueOnce(null);
    mockRecordingCreate.mockResolvedValueOnce({ id: "rec-quiet" });
    mockGetEventAttendeeIds.mockResolvedValue(["u-1"]);

    const synced: unknown[] = [];
    await RecordingService.syncSessionRecordings(
      {
        id: "m-quiet",
        streamCallId: "call-quiet",
        occurrence: {
          appointment: {
            organizationId: null,
            webinar: { webinarPlan: { title: "Quiet" } },
          } as never,
        },
      },
      synced as never,
    );

    expect(synced).toHaveLength(1);
    expect(mockNotifyRecordingAvailable).not.toHaveBeenCalled();
    expect(mockStageEmailOnce).not.toHaveBeenCalled();
  });
});
