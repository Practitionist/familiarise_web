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
      count: jest.fn(),
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

  async function invokeDownloadRoute(options: {
    appointmentStatus: string;
    docId?: string;
    signedUrlResult?:
      { ok: true; signedUrl: string } | { ok: false; code: string };
    query?: string;
  }) {
    const docId = options.docId ?? "doc-1";
    const query = options.query ?? "disposition=inline&format=json";

    mockedGetSession.mockResolvedValue({ user: { id: "learner-1" } });
    mockedFindFirstAppointment.mockResolvedValue({
      id: "apt-1",
      consultation: {
        status: options.appointmentStatus,
        consultationPlan: { consultantProfile: { userId: "expert-user-1" } },
      },
      subscription: null,
      webinar: null,
      class: null,
    });
    mockedFindFirstDoc.mockResolvedValue({
      id: docId,
      appointmentId: "apt-1",
      storagePath: `appointments/apt-1/${docId}.pdf`,
      originalName: "Resume.pdf",
      mimeType: "application/pdf",
      isStorageMissing: false,
      uploadedByRole: "CONSULTEE",
    });
    if (options.signedUrlResult) {
      mockedCreateSignedUrl.mockResolvedValue(options.signedUrlResult);
    }

    const req = new Request(
      `http://localhost/api/appointments/apt-1/documents/${docId}/download?${query}`,
    );
    return downloadAppointmentDocument(req as never, {
      params: Promise.resolve({
        appointmentId: "apt-1",
        documentId: docId,
      }),
    });
  }

  describe("GET /api/appointments/[appointmentId]/documents/[documentId]/download", () => {
    it("permits COMPLETED appointments and returns short-lived presigned JSON metadata without buffering bytes", async () => {
      const signedUrl =
        "https://project.supabase.co/storage/v1/object/sign/documents/appointments/apt-1/doc-1.pdf?token=short60s";
      const res = await invokeDownloadRoute({
        appointmentStatus: "COMPLETED",
        signedUrlResult: { ok: true, signedUrl },
      });

      expect(res.status).toBe(200);
      expect(res.headers.get("Cache-Control")).toContain("no-store");
      expect(await res.json()).toEqual({
        signedUrl,
        mimeType: "application/pdf",
        originalName: "Resume.pdf",
        previewable: true,
      });
    });

    it("returns 404 STORAGE_MISSING when storage verification detects missing object", async () => {
      const res = await invokeDownloadRoute({
        appointmentStatus: "COMPLETED",
        docId: "doc-missing",
        signedUrlResult: { ok: false, code: "STORAGE_MISSING" },
      });

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.code).toBe("STORAGE_MISSING");
    });

    it("rejects CANCELLED appointments with 403 APPOINTMENT_TERMINAL", async () => {
      const res = await invokeDownloadRoute({
        appointmentStatus: "CANCELLED",
      });

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.code).toBe("APPOINTMENT_TERMINAL");
      expect(mockedCreateSignedUrl).not.toHaveBeenCalled();
    });

    it("returns 302 redirect to presigned URL when format=json is omitted", async () => {
      const signedUrl =
        "https://project.supabase.co/storage/v1/object/sign/documents/appointments/apt-1/doc-1.pdf?token=short60s";
      const res = await invokeDownloadRoute({
        appointmentStatus: "APPROVED",
        signedUrlResult: { ok: true, signedUrl },
        query: "disposition=attachment",
      });

      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe(signedUrl);
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

    it("returns 409 SUPERSEDED when the learner uploaded a newer version before the review landed", async () => {
      mockedGetSession.mockResolvedValue({ user: { id: "expert-user-1" } });
      mockedFindFirstDoc.mockResolvedValue({
        id: "doc-v1",
        appointmentId: "apt-1",
        originalName: "Resume.pdf",
        reviewStatus: "IN_REVIEW",
        reviewNotes: null,
        uploadedByRole: "CONSULTEE",
        rootDocumentId: null,
        versionNo: 1,
        appointment: {
          consultation: { status: "APPROVED" },
          subscription: null,
        },
      });
      mockedUpdateMany.mockResolvedValue({ count: 0 });
      (prisma.appointmentDocument.count as jest.Mock).mockResolvedValue(1);

      const res = await patchAppointmentDocument(
        new Request(
          "http://localhost/api/appointments/apt-1/documents/doc-v1",
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ reviewStatus: "APPROVED" }),
          },
        ) as never,
        {
          params: Promise.resolve({
            appointmentId: "apt-1",
            documentId: "doc-v1",
          }),
        },
      );

      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe("SUPERSEDED");
      expect(mockedUpdateMany.mock.calls[0][0].where).toMatchObject({
        reviewStatus: "IN_REVIEW",
        threadVersions: {
          none: {
            deletedAt: null,
            uploadedByRole: "CONSULTEE",
            versionNo: { gt: 1 },
          },
        },
      });
      expect(mockedNotifyReviewed).not.toHaveBeenCalled();
    });
  });

  describe("Thread slot reservation & SQL root-thread filtering invariants", () => {
    async function learnerSlot(
      rootRole: "CONSULTEE" | "CONSULTANT",
      liveVersions: {
        uploadedByRole: string;
        reviewStatus: string;
        versionNo: number;
      }[],
    ) {
      const { resolveDocumentThreadSlot } =
        await import("@/lib/documents/document-review");
      const mockTx = {
        $executeRaw: jest.fn().mockResolvedValue(1),
        appointmentDocument: {
          findFirst: jest.fn().mockResolvedValue({
            id: "v-latest",
            rootDocumentId: "root-1",
            uploadedByRole: "CONSULTEE",
            rootDocument: { uploadedByRole: rootRole },
          }),
          findMany: jest.fn().mockResolvedValue(liveVersions),
          aggregate: jest.fn().mockResolvedValue({
            _max: {
              versionNo: Math.max(...liveVersions.map((v) => v.versionNo)),
            },
          }),
          count: jest.fn(),
        },
      };
      const slot = resolveDocumentThreadSlot(mockTx as never, {
        appointmentId: "apt-1",
        parentDocumentId: "v-latest",
        uploadedByRole: "CONSULTEE",
      });
      return { slot, mockTx };
    }
    const learner = (versionNo: number, reviewStatus = "NEEDS_REVISION") => ({
      uploadedByRole: "CONSULTEE",
      reviewStatus,
      versionNo,
    });
    const expertReply = (versionNo: number) => ({
      uploadedByRole: "CONSULTANT",
      reviewStatus: "APPROVED",
      versionNo,
    });

    it.each([
      ["IN_REVIEW", "THREAD_IN_REVIEW"],
      ["APPROVED", "THREAD_CLOSED"],
      ["REJECTED", "THREAD_CLOSED"],
    ])(
      "refuses a learner version while the latest learner row is %s (%s), under the appointment lock",
      async (status, code) => {
        const { slot, mockTx } = await learnerSlot("CONSULTEE", [
          learner(1, "NEEDS_REVISION"),
          expertReply(2),
          learner(3, status),
        ]);
        await expect(slot).rejects.toMatchObject({ code });
        expect(mockTx.$executeRaw).toHaveBeenCalledTimes(1);
      },
    );

    it("refuses a learner version on an expert-shared root", async () => {
      const { slot } = await learnerSlot("CONSULTANT", [expertReply(1)]);
      await expect(slot).rejects.toMatchObject({ code: "THREAD_CLOSED" });
    });

    it("caps learner versions at 10 and does not count expert replies", async () => {
      const ten = Array.from({ length: 10 }, (_, i) => learner(i * 2 + 1));
      const atCap = await learnerSlot("CONSULTEE", [
        ...ten,
        expertReply(2),
        expertReply(4),
      ]);
      await expect(atCap.slot).rejects.toMatchObject({
        code: "VERSION_LIMIT_REACHED",
      });

      const nine = Array.from({ length: 9 }, (_, i) => learner(i * 2 + 1));
      const replies = Array.from({ length: 8 }, (_, i) =>
        expertReply(i * 2 + 2),
      );
      const underCap = await learnerSlot("CONSULTEE", [...nine, ...replies]);
      await expect(underCap.slot).resolves.toEqual({
        rootDocumentId: "root-1",
        versionNo: 18,
      });
    });

    it("builds SQL-pushed OR filter on root threads via buildRootThreadStatusWhere", async () => {
      const { buildRootThreadStatusWhere } =
        await import("@/lib/documents/document-review");

      const baseWhere = { deletedAt: null, rootDocumentId: null };
      expect(buildRootThreadStatusWhere(baseWhere, null)).toEqual(baseWhere);
      expect(buildRootThreadStatusWhere(baseWhere, "PENDING")).toMatchObject({
        deletedAt: null,
        rootDocumentId: null,
        OR: [
          {
            threadVersions: {
              some: {
                deletedAt: null,
                uploadedByRole: "CONSULTEE",
                reviewStatus: "PENDING",
              },
            },
          },
          {
            reviewStatus: "PENDING",
            threadVersions: {
              none: {
                deletedAt: null,
                uploadedByRole: "CONSULTEE",
              },
            },
          },
        ],
      });
    });

    it("validates direct JSON commit payloads, multipart form uploads, preflight thread limits, and notification target extraction in upload-pipeline", async () => {
      const {
        parseDocumentUploadInput,
        preflightThreadLimits,
        extractReviewNotificationTarget,
      } = await import("@/lib/documents/upload-pipeline");

      const validJsonReq = new Request("http://localhost/upload", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          storagePath: "appointments/apt-1/consultee-c1/123_cv.pdf",
          originalName: "cv.pdf",
          mimeType: "application/pdf",
          fileSize: 2048,
          description: "Initial CV",
          responseToDocumentId: "parent-1",
        }),
      });
      const parsedJson = await parseDocumentUploadInput(validJsonReq as never);
      expect(parsedJson).toMatchObject({
        ok: true,
        mode: "direct",
        originalName: "cv.pdf",
        responseToDocumentId: "parent-1",
      });

      const invalidMimeReq = new Request("http://localhost/upload", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          storagePath: "appointments/apt-1/consultee-c1/123_payload.exe",
          originalName: "payload.exe",
          mimeType: "application/x-msdownload",
          fileSize: 512,
        }),
      });
      const rejectedMime = await parseDocumentUploadInput(
        invalidMimeReq as never,
      );
      expect(rejectedMime.ok).toBe(false);

      (prisma.appointmentDocument.count as jest.Mock).mockResolvedValueOnce(20);
      const capHit = await preflightThreadLimits("apt-1", null, "CONSULTEE");
      expect(capHit).not.toBeNull();
      expect(capHit?.status).toBe(400);

      expect(
        extractReviewNotificationTarget({
          organizationId: null,
          consultation: {
            requestedBy: { id: "cp-1", user: { id: "learner-user-9" } },
            consultationPlan: {
              consultantProfile: { user: { name: "Dr. Rao" } },
            },
          },
          subscription: null,
        }),
      ).toEqual({
        consulteeProfileId: "cp-1",
        recipientId: "learner-user-9",
        reviewerName: "Dr. Rao",
        organizationId: null,
      });
    });

    it("formats disposition headers and detects inline previewable MIME/extension pairs", async () => {
      const {
        getAppointmentDocumentUrl,
        getPlanMaterialUrl,
        isPreviewableMimeType,
        formatContentDisposition,
      } = await import("@/lib/documents/urls");

      expect(getAppointmentDocumentUrl("apt-1", "doc-1", "inline")).toContain(
        "disposition=inline",
      );
      expect(getPlanMaterialUrl("mat-1", "attachment")).toContain(
        "disposition=attachment",
      );
      expect(isPreviewableMimeType("application/pdf", "spec.pdf")).toBe(true);
      expect(isPreviewableMimeType("text/plain", "notes.txt")).toBe(true);
      expect(isPreviewableMimeType("application/zip", "bundle.zip")).toBe(
        false,
      );
      expect(formatContentDisposition("attachment", 'my "cv".pdf')).toContain(
        "filename=",
      );
    });
  });
});
