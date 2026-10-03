/**
 * @jest-environment node
 */

import { NextRequest } from "next/server";

const mockGetSession = jest.fn();
const mockRequireApiAuth = jest.fn();
const mockResolveMeetingAccess = jest.fn();
const mockGetRecordingNotice = jest.fn();
const mockRecordRecordingConsent = jest.fn();
const mockGetRecordingById = jest.fn();
const mockRecordingUpdate = jest.fn();
const mockRecordingPurchaseFindFirst = jest.fn();
const mockMeetingUpdate = jest.fn();
const mockDeleteRecordingObject = jest.fn();
const mockStopRecording = jest.fn();

jest.mock("../../lib/auth-server", () => ({
  getSession: (...args: unknown[]) => mockGetSession(...args),
}));

jest.mock("../../lib/auth-helpers", () => ({
  requireApiAuth: (...args: unknown[]) => mockRequireApiAuth(...args),
}));

jest.mock("../../lib/meetings/access", () => ({
  resolveMeetingAccess: (...args: unknown[]) =>
    mockResolveMeetingAccess(...args),
}));

jest.mock("../../lib/stream/recording-consent", () => ({
  getRecordingNotice: (...args: unknown[]) => mockGetRecordingNotice(...args),
  recordRecordingConsent: (...args: unknown[]) =>
    mockRecordRecordingConsent(...args),
}));

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    recording: {
      update: (...args: unknown[]) => mockRecordingUpdate(...args),
    },
    recordingPurchase: {
      findFirst: (...args: unknown[]) =>
        mockRecordingPurchaseFindFirst(...args),
    },
    meeting: {
      update: (...args: unknown[]) => mockMeetingUpdate(...args),
    },
  },
}));

jest.mock("../../lib/stream/recording-storage", () => ({
  getBestRecordingUrl: jest.fn(),
  deleteRecordingObject: (...args: unknown[]) =>
    mockDeleteRecordingObject(...args),
}));

jest.mock("../../lib/stream/recording-service", () => ({
  RecordingService: {
    getRecordingById: (...args: unknown[]) => mockGetRecordingById(...args),
    stopRecording: (...args: unknown[]) => mockStopRecording(...args),
  },
}));

jest.mock("../../lib/stream-logger", () => ({
  streamLogger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

import {
  PATCH as patchRecording,
  DELETE as deleteRecording,
} from "../../app/api/stream/recordings/[recordingId]/route";
import { POST as postRecordingConsent } from "../../app/api/meetings/[meetingId]/recording-consent/route";

describe("Recording CRUD & Mid-Call DPDP Consent Withdrawal", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("PATCH /api/stream/recordings/[recordingId]", () => {
    it("allows the host consultant to rename a recording", async () => {
      mockGetSession.mockResolvedValue({
        user: {
          id: "consultant-user-1",
          role: "CONSULTANT",
          consultantProfileId: "consultant-profile-1",
        },
      });
      mockGetRecordingById.mockResolvedValue({
        id: "rec-1",
        title: "Old Title",
        meeting: {
          occurrence: {
            appointment: {
              consultation: {
                consultationPlan: {
                  consultantProfileId: "consultant-profile-1",
                },
              },
              subscription: null,
              webinar: null,
              class: null,
            },
          },
        },
      });
      mockRecordingUpdate.mockResolvedValue({
        id: "rec-1",
        title: "New Session Title",
        updatedAt: new Date("2026-03-10T10:00:00Z"),
      });

      const req = new NextRequest(
        "http://localhost:3000/api/stream/recordings/rec-1",
        {
          method: "PATCH",
          body: JSON.stringify({ title: "New Session Title" }),
          headers: { "Content-Type": "application/json" },
        },
      );

      const res = await patchRecording(req, {
        params: Promise.resolve({ recordingId: "rec-1" }),
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.recording.title).toBe("New Session Title");
    });

    it("rejects non-owners with 403", async () => {
      mockGetSession.mockResolvedValue({
        user: {
          id: "other-user",
          role: "CONSULTANT",
          consultantProfileId: "other-consultant-profile",
        },
      });
      mockGetRecordingById.mockResolvedValue({
        id: "rec-1",
        title: "Old Title",
        meeting: {
          occurrence: {
            appointment: {
              consultation: {
                consultationPlan: {
                  consultantProfileId: "consultant-profile-1",
                },
              },
              subscription: null,
              webinar: null,
              class: null,
            },
          },
        },
      });

      const req = new NextRequest(
        "http://localhost:3000/api/stream/recordings/rec-1",
        {
          method: "PATCH",
          body: JSON.stringify({ title: "Attempted Rename" }),
          headers: { "Content-Type": "application/json" },
        },
      );

      const res = await patchRecording(req, {
        params: Promise.resolve({ recordingId: "rec-1" }),
      });
      expect(res.status).toBe(403);
    });
  });

  describe("DELETE /api/stream/recordings/[recordingId]", () => {
    it("blocks deletion with 409 when published recording has active purchases", async () => {
      mockGetSession.mockResolvedValue({
        user: {
          id: "consultant-user-1",
          role: "CONSULTANT",
          consultantProfileId: "consultant-profile-1",
        },
      });
      mockGetRecordingById.mockResolvedValue({
        id: "rec-published",
        listingStatus: "PUBLISHED",
        storagePath: "recordings/rec-published.mp4",
        previewClipStoragePath: null,
        meeting: {
          occurrence: {
            appointment: {
              consultation: {
                consultationPlan: {
                  consultantProfileId: "consultant-profile-1",
                },
              },
              subscription: null,
              webinar: null,
              class: null,
            },
          },
        },
      });
      mockRecordingPurchaseFindFirst.mockResolvedValue({ id: "purchase-1" });

      const req = new NextRequest(
        "http://localhost:3000/api/stream/recordings/rec-published",
        { method: "DELETE" },
      );

      const res = await deleteRecording(req, {
        params: Promise.resolve({ recordingId: "rec-published" }),
      });
      expect(res.status).toBe(409);
      expect(mockDeleteRecordingObject).not.toHaveBeenCalled();
    });

    it("deletes storage objects and marks recording EXPIRED + UNPUBLISHED when authorized", async () => {
      mockGetSession.mockResolvedValue({
        user: {
          id: "consultant-user-1",
          role: "CONSULTANT",
          consultantProfileId: "consultant-profile-1",
        },
      });
      mockGetRecordingById.mockResolvedValue({
        id: "rec-del",
        listingStatus: "UNLISTED",
        storagePath: "recordings/rec-del.mp4",
        previewClipStoragePath: "previews/rec-del.mp4",
        meeting: {
          occurrence: {
            appointment: {
              consultation: {
                consultationPlan: {
                  consultantProfileId: "consultant-profile-1",
                },
              },
              subscription: null,
              webinar: null,
              class: null,
            },
          },
        },
      });
      mockDeleteRecordingObject.mockResolvedValue({ success: true });
      mockRecordingUpdate.mockResolvedValue({ id: "rec-del" });

      const req = new NextRequest(
        "http://localhost:3000/api/stream/recordings/rec-del",
        { method: "DELETE" },
      );

      const res = await deleteRecording(req, {
        params: Promise.resolve({ recordingId: "rec-del" }),
      });
      expect(res.status).toBe(200);
      expect(mockDeleteRecordingObject).toHaveBeenCalledWith(
        "recordings/rec-del.mp4",
      );
      expect(mockDeleteRecordingObject).toHaveBeenCalledWith(
        "previews/rec-del.mp4",
      );
      expect(mockRecordingUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "rec-del" },
          data: expect.objectContaining({
            status: "EXPIRED",
            recordingUrl: "",
            storageUrl: null,
            storagePath: null,
            listingStatus: "UNPUBLISHED",
          }),
        }),
      );
    });
  });

  describe("POST /api/meetings/[meetingId]/recording-consent", () => {
    it("immediately stops an active recording when a 1:1 participant withdraws consent", async () => {
      mockRequireApiAuth.mockResolvedValue({
        ok: true,
        session: { user: { id: "consultee-user-1", role: "CONSULTEE" } },
      });
      mockResolveMeetingAccess.mockResolvedValue({
        hasAccess: true,
        meetingId: "meeting-1",
        streamCallId: "consultation-slot-1",
        isRecording: true,
        appointment: {
          consultationId: "cons-1",
        },
      });
      mockGetRecordingNotice.mockResolvedValue({
        required: true,
        regime: "CO_CONSENT",
        noticeVersion: "v1",
      });
      mockRecordRecordingConsent.mockResolvedValue(undefined);
      mockStopRecording.mockResolvedValue({ success: true });
      mockMeetingUpdate.mockResolvedValue({});

      const req = new NextRequest(
        "http://localhost:3000/api/meetings/meeting-1/recording-consent",
        {
          method: "POST",
          body: JSON.stringify({ decision: "DECLINED" }),
          headers: { "Content-Type": "application/json" },
        },
      );

      const res = await postRecordingConsent(req, {
        params: Promise.resolve({ meetingId: "meeting-1" }),
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.decision).toBe("DECLINED");
      expect(mockStopRecording).toHaveBeenCalledWith(
        "consultation-slot-1",
        "consultee-user-1",
      );
      expect(mockMeetingUpdate).toHaveBeenCalledWith({
        where: { id: "meeting-1" },
        data: { isRecording: false },
      });
    });
  });
});
