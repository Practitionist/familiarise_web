/**
 * @jest-environment node
 */

import { GET as downloadAppointmentDocument } from "../../app/api/appointments/[appointmentId]/documents/[documentId]/download/route";
import {
  DELETE as deleteAppointmentDocument,
  PATCH as patchAppointmentDocument,
} from "../../app/api/appointments/[appointmentId]/documents/[documentId]/route";
import { getSession } from "@/lib/auth-server";
import prisma from "@/lib/prisma";
import { createSignedStorageUrl } from "@/lib/documents/storage-verify";
import { notifyDocumentReviewed } from "@/lib/novu/service";

jest.mock("../../lib/auth-server", () => ({
  __esModule: true,
  getSession: jest.fn(),
}));

jest.mock("../../lib/documents/storage-verify", () => {
  const actual = jest.requireActual("../../lib/documents/storage-verify");
  return {
    ...actual,
    createSignedStorageUrl: jest.fn(),
  };
});

jest.mock("../../lib/rate-limit", () => ({
  __esModule: true,
  applyRateLimit: jest.fn().mockResolvedValue(null),
  documentReviewLimiter: {},
}));

jest.mock("../../lib/novu/service", () => ({
  __esModule: true,
  notifyDocumentReviewed: jest.fn().mockResolvedValue({ id: "outbox-1" }),
}));

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    appointmentDocument: {
      findFirst: jest.fn(),
      updateMany: jest.fn(),
      findUniqueOrThrow: jest.fn(),
    },
    appointment: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
    },
  },
}));

const mockedGetSession = getSession as jest.Mock;
const mockedFindFirstDoc = prisma.appointmentDocument.findFirst as jest.Mock;
const mockedUpdateMany = prisma.appointmentDocument.updateMany as jest.Mock;
const mockedFindUniqueOrThrow = prisma.appointmentDocument
  .findUniqueOrThrow as jest.Mock;
const mockedFindFirstAppointment = prisma.appointment.findFirst as jest.Mock;
const mockedFindUniqueAppointment = prisma.appointment.findUnique as jest.Mock;
const mockedCreateSignedUrl = createSignedStorageUrl as jest.Mock;
const mockedNotifyReviewed = notifyDocumentReviewed as jest.Mock;

describe("Document presigned download, CAS deletion, and review state machine invariants", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("GET /api/appointments/[appointmentId]/documents/[documentId]/download", () => {
    it("permits COMPLETED appointments and returns short-lived presigned JSON metadata without buffering bytes", async () => {
      mockedGetSession.mockResolvedValue({ user: { id: "learner-1" } });
      mockedFindFirstAppointment.mockResolvedValue({
        id: "apt-1",
        consultation: { status: "COMPLETED" },
        subscription: null,
        webinar: null,
        class: null,
      });
      mockedFindFirstDoc.mockResolvedValue({
        id: "doc-1",
        appointmentId: "apt-1",
        storagePath: "appointments/apt-1/resume.pdf",
        originalName: "Resume.pdf",
        mimeType: "application/pdf",
        isStorageMissing: false,
      });
      mockedCreateSignedUrl.mockResolvedValue({
        ok: true,
        signedUrl:
          "https://project.supabase.co/storage/v1/object/sign/documents/appointments/apt-1/resume.pdf?token=short60s",
      });

      const req = new Request(
        "http://localhost/api/appointments/apt-1/documents/doc-1/download?disposition=inline&format=json",
      );
      const res = await downloadAppointmentDocument(req as never, {
        params: Promise.resolve({
          appointmentId: "apt-1",
          documentId: "doc-1",
        }),
      });

      expect(res.status).toBe(200);
      expect(res.headers.get("Cache-Control")).toContain("no-store");
      expect(await res.json()).toEqual({
        signedUrl:
          "https://project.supabase.co/storage/v1/object/sign/documents/appointments/apt-1/resume.pdf?token=short60s",
        mimeType: "application/pdf",
        originalName: "Resume.pdf",
        previewable: true,
      });
    });

    it("returns 404 STORAGE_MISSING when storage verification detects missing object", async () => {
      mockedGetSession.mockResolvedValue({ user: { id: "learner-1" } });
      mockedFindFirstAppointment.mockResolvedValue({
        id: "apt-1",
        consultation: { status: "COMPLETED" },
        subscription: null,
        webinar: null,
        class: null,
      });
      mockedFindFirstDoc.mockResolvedValue({
        id: "doc-missing",
        appointmentId: "apt-1",
        storagePath: "appointments/apt-1/missing.pdf",
        originalName: "Missing.pdf",
        mimeType: "application/pdf",
        isStorageMissing: false,
      });
      mockedCreateSignedUrl.mockResolvedValue({
        ok: false,
        code: "STORAGE_MISSING",
      });

      const req = new Request(
        "http://localhost/api/appointments/apt-1/documents/doc-missing/download?disposition=inline&format=json",
      );
      const res = await downloadAppointmentDocument(req as never, {
        params: Promise.resolve({
          appointmentId: "apt-1",
          documentId: "doc-missing",
        }),
      });

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.code).toBe("STORAGE_MISSING");
    });

    it("rejects CANCELLED appointments with 403 APPOINTMENT_TERMINAL", async () => {
      mockedGetSession.mockResolvedValue({ user: { id: "learner-1" } });
      mockedFindFirstAppointment.mockResolvedValue({
        id: "apt-1",
        consultation: { status: "CANCELLED" },
        subscription: null,
        webinar: null,
        class: null,
      });

      const req = new Request(
        "http://localhost/api/appointments/apt-1/documents/doc-1/download?disposition=inline&format=json",
      );
      const res = await downloadAppointmentDocument(req as never, {
        params: Promise.resolve({
          appointmentId: "apt-1",
          documentId: "doc-1",
        }),
      });

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.code).toBe("APPOINTMENT_TERMINAL");
      expect(mockedCreateSignedUrl).not.toHaveBeenCalled();
    });

    it("returns 302 redirect to presigned URL when format=json is omitted", async () => {
      mockedGetSession.mockResolvedValue({ user: { id: "learner-1" } });
      mockedFindFirstAppointment.mockResolvedValue({
        id: "apt-1",
        consultation: { status: "APPROVED" },
        subscription: null,
        webinar: null,
        class: null,
      });
      mockedFindFirstDoc.mockResolvedValue({
        id: "doc-1",
        appointmentId: "apt-1",
        storagePath: "appointments/apt-1/resume.pdf",
        originalName: "Resume.pdf",
        mimeType: "application/pdf",
        isStorageMissing: false,
      });
      mockedCreateSignedUrl.mockResolvedValue({
        ok: true,
        signedUrl:
          "https://project.supabase.co/storage/v1/object/sign/documents/appointments/apt-1/resume.pdf?token=short60s",
      });

      const req = new Request(
        "http://localhost/api/appointments/apt-1/documents/doc-1/download?disposition=attachment",
      );
      const res = await downloadAppointmentDocument(req as never, {
        params: Promise.resolve({
          appointmentId: "apt-1",
          documentId: "doc-1",
        }),
      });

      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe(
        "https://project.supabase.co/storage/v1/object/sign/documents/appointments/apt-1/resume.pdf?token=short60s",
      );
    });
  });

  describe("DELETE /api/appointments/[appointmentId]/documents/[documentId]", () => {
    it("returns 409 DOCUMENT_NOT_DELETABLE via atomic CAS when consultee submission is already reviewed", async () => {
      mockedGetSession.mockResolvedValue({ user: { id: "learner-1" } });
      mockedFindFirstDoc.mockResolvedValue({
        id: "doc-reviewed",
        appointmentId: "apt-1",
        uploadedByRole: "CONSULTEE",
        reviewStatus: "APPROVED",
        appointment: {
          consultation: {
            consultantProfileId: "cprof-1",
            consultationPlan: {
              consultantProfile: { userId: "expert-user-1" },
            },
          },
          subscription: null,
        },
      });
      mockedUpdateMany.mockResolvedValue({ count: 0 });

      const req = new Request(
        "http://localhost/api/appointments/apt-1/documents/doc-reviewed",
        { method: "DELETE" },
      );
      const res = await deleteAppointmentDocument(req as never, {
        params: Promise.resolve({
          appointmentId: "apt-1",
          documentId: "doc-reviewed",
        }),
      });

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.code).toBe("DOCUMENT_NOT_DELETABLE");
      expect(mockedUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: "doc-reviewed",
            uploadedByRole: "CONSULTEE",
            reviewStatus: "PENDING",
            deletedAt: null,
          }),
        }),
      );
    });

    it("allows consultant to delete standalone consultant handout via atomic CAS", async () => {
      mockedGetSession.mockResolvedValue({ user: { id: "expert-user-1" } });
      mockedFindFirstDoc.mockResolvedValue({
        id: "handout-1",
        appointmentId: "apt-1",
        uploadedByRole: "CONSULTANT",
        rootDocumentId: null,
        appointment: {
          consultation: {
            consultantProfileId: "cprof-1",
            consultationPlan: {
              consultantProfile: { userId: "expert-user-1" },
            },
          },
          subscription: null,
        },
      });
      mockedUpdateMany.mockResolvedValue({ count: 1 });

      const req = new Request(
        "http://localhost/api/appointments/apt-1/documents/handout-1",
        { method: "DELETE" },
      );
      const res = await deleteAppointmentDocument(req as never, {
        params: Promise.resolve({
          appointmentId: "apt-1",
          documentId: "handout-1",
        }),
      });

      expect(res.status).toBe(200);
      expect(mockedUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: "handout-1",
            uploadedByRole: "CONSULTANT",
            rootDocumentId: null,
            deletedAt: null,
          }),
        }),
      );
    });
  });

  describe("PATCH /api/appointments/[appointmentId]/documents/[documentId]", () => {
    it("updates reviewNotes without overwriting reviewedAt or re-sending notification when reviewStatus is unchanged", async () => {
      mockedGetSession.mockResolvedValue({ user: { id: "expert-user-1" } });
      mockedFindFirstDoc.mockResolvedValue({
        id: "doc-1",
        appointmentId: "apt-1",
        originalName: "Resume.pdf",
        reviewStatus: "APPROVED",
        reviewNotes: "Good work",
        uploadedByRole: "CONSULTEE",
        appointment: {
          consultation: { status: "APPROVED" },
          subscription: null,
        },
      });
      mockedUpdateMany.mockResolvedValue({ count: 1 });
      mockedFindUniqueOrThrow.mockResolvedValue({
        id: "doc-1",
        reviewStatus: "APPROVED",
        reviewNotes: "Updated note only",
      });

      const req = new Request(
        "http://localhost/api/appointments/apt-1/documents/doc-1",
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            reviewStatus: "APPROVED",
            reviewNotes: "Updated note only",
          }),
        },
      );
      const res = await patchAppointmentDocument(req as never, {
        params: Promise.resolve({
          appointmentId: "apt-1",
          documentId: "doc-1",
        }),
      });

      expect(res.status).toBe(200);
      const casArg = mockedUpdateMany.mock.calls[0][0];
      expect(casArg.data).toEqual({ reviewNotes: "Updated note only" });
      expect("reviewedAt" in casArg.data).toBe(false);
      expect("reviewedById" in casArg.data).toBe(false);
      expect(mockedNotifyReviewed).not.toHaveBeenCalled();
      expect(mockedFindUniqueAppointment).not.toHaveBeenCalled();
    });
  });
});
