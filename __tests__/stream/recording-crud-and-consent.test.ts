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
const mockRecordingUpdateMany = jest.fn();
const mockRecordingUpdateManyAndReturn = jest.fn();
const mockRecordingFindUnique = jest.fn();
const mockRecordingPurchaseFindFirst = jest.fn();
const mockMeetingUpdate = jest.fn();
const mockDeleteRecordingAssets = jest.fn();
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
      updateMany: (...args: unknown[]) => mockRecordingUpdateMany(...args),
      updateManyAndReturn: (...args: unknown[]) =>
        mockRecordingUpdateManyAndReturn(...args),
      findUnique: (...args: unknown[]) => mockRecordingFindUnique(...args),
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
  deleteRecordingAssets: (...args: unknown[]) =>
    mockDeleteRecordingAssets(...args),
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
    mockRecordingPurchaseFindFirst.mockResolvedValue(null);
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
        recordingUrl: "https://internal.example/raw.mp4",
        storagePath: "recordings/rec-1.mp4",
        previewClipStoragePath: "previews/rec-1.mp4",
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
      expect(data.recording.storagePath).toBeUndefined();
      expect(data.recording.recordingUrl).toBeUndefined();
      expect(data.recording.previewClipStoragePath).toBeUndefined();
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
    it("blocks deletion with 409 when published or unpublished recording has active or pending purchases", async () => {
      mockGetSession.mockResolvedValue({
        user: {
          id: "consultant-user-1",
          role: "CONSULTANT",
          consultantProfileId: "consultant-profile-1",
        },
      });
      mockGetRecordingById.mockResolvedValue({
        id: "rec-published",
        listingStatus: "UNPUBLISHED",
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
      expect(mockDeleteRecordingAssets).not.toHaveBeenCalled();
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
        status: "AVAILABLE",
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
      mockDeleteRecordingAssets.mockResolvedValue({ success: true });
      mockRecordingUpdateManyAndReturn.mockResolvedValueOnce([
        { id: "rec-del", storagePath: "recordings/rec-del.mp4" },
      ]);
      mockRecordingUpdateMany.mockResolvedValue({ count: 1 });
      mockRecordingFindUnique.mockResolvedValue({ id: "rec-del" });

      const req = new NextRequest(
        "http://localhost:3000/api/stream/recordings/rec-del",
        { method: "DELETE" },
      );

      const res = await deleteRecording(req, {
        params: Promise.resolve({ recordingId: "rec-del" }),
      });
      expect(res.status).toBe(200);
      // The row is CAS-expired before any stored object is touched.
      expect(mockRecordingUpdateManyAndReturn).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "rec-del", status: "AVAILABLE" },
          data: expect.objectContaining({
            status: "EXPIRED",
            recordingUrl: "",
            listingStatus: "UNPUBLISHED",
          }),
        }),
      );
      expect(
        mockRecordingUpdateManyAndReturn.mock.invocationCallOrder[0],
      ).toBeLessThan(mockDeleteRecordingAssets.mock.invocationCallOrder[0]);
      expect(mockDeleteRecordingAssets).toHaveBeenCalledWith({
        id: "rec-del",
        storagePath: "recordings/rec-del.mp4",
      });
      expect(mockRecordingUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "rec-del", status: "EXPIRED" },
          data: expect.objectContaining({
            storagePath: null,
            thumbnailUrl: null,
            previewClipStoragePath: null,
          }),
        }),
      );
    });

    it("refuses with 409 and deletes nothing when the row changed status mid-request", async () => {
      mockGetSession.mockResolvedValue({
        user: {
          id: "consultant-user-1",
          role: "CONSULTANT",
          consultantProfileId: "consultant-profile-1",
        },
      });
      mockGetRecordingById.mockResolvedValue({
        id: "rec-del",
        status: "READY",
        listingStatus: "UNLISTED",
        storagePath: null,
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
      mockDeleteRecordingAssets.mockResolvedValue({ success: true });
      // A copy finished between the read and the write: READY is now AVAILABLE.
      mockRecordingUpdateManyAndReturn.mockResolvedValueOnce([]);
      mockRecordingUpdateMany.mockResolvedValue({ count: 0 });

      const raced = await deleteRecording(
        new NextRequest("http://localhost:3000/api/stream/recordings/rec-del", {
          method: "DELETE",
        }),
        { params: Promise.resolve({ recordingId: "rec-del" }) },
      );
      expect(raced.status).toBe(409);
      expect(mockDeleteRecordingAssets).not.toHaveBeenCalled();
    });

    it("keeps the deletion when the asset delete fails, leaving pointers for the expiry sweep", async () => {
      mockGetSession.mockResolvedValue({
        user: {
          id: "consultant-user-1",
          role: "CONSULTANT",
          consultantProfileId: "consultant-profile-1",
        },
      });
      mockGetRecordingById.mockResolvedValue({
        id: "rec-del",
        status: "AVAILABLE",
        listingStatus: "UNLISTED",
        storagePath: "recordings/rec-del.mp4",
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
      mockRecordingUpdateManyAndReturn.mockResolvedValueOnce([
        { id: "rec-del", storagePath: "recordings/rec-del.mp4" },
      ]);
      mockDeleteRecordingAssets.mockResolvedValue({
        success: false,
        error: "R2 DELETE failed",
      });
      mockRecordingFindUnique.mockResolvedValue({ id: "rec-del" });

      const res = await deleteRecording(
        new NextRequest("http://localhost:3000/api/stream/recordings/rec-del", {
          method: "DELETE",
        }),
        { params: Promise.resolve({ recordingId: "rec-del" }) },
      );
      expect(res.status).toBe(200);
      expect(mockRecordingUpdateMany).not.toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ storagePath: null }),
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
