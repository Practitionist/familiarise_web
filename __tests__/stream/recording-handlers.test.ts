/**
 * @jest-environment node
 */

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
import { RecordingTransferService } from "../../lib/stream/recording-transfer-service";

const mockMeetingFindUnique = prisma.meeting.findUnique as jest.Mock;
const mockMeetingUpdate = prisma.meeting.update as jest.Mock;
const mockRecordingFindFirst = prisma.recording.findFirst as jest.Mock;
const mockRecordingUpdate = prisma.recording.update as jest.Mock;

describe("Stream recording webhook handlers", () => {
  beforeEach(() => {
    jest.clearAllMocks();
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
});
