/**
 * @jest-environment node
 */

import { GET as downloadDocument } from "../../app/api/appointments/[appointmentId]/documents/[documentId]/download/route";
import { DELETE as deleteDocument } from "../../app/api/appointments/[appointmentId]/documents/[documentId]/route";
import { POST as reviewDocument } from "../../app/api/appointments/[appointmentId]/documents/[documentId]/review/route";
import { POST as uploadDocument } from "../../app/api/appointments/[appointmentId]/documents/route";
import { getSession } from "@/lib/auth-server";
import prisma from "@/lib/prisma";
import {
  createSignedStorageUrl,
  verifyDirectUploadedObject,
} from "@/lib/documents/storage-verify";
import { notifyDocumentAdded } from "@/lib/documents/document-notify";
import { resolveDocumentParty } from "@/lib/documents/document-party";

jest.mock("../../lib/auth-server", () => ({
  __esModule: true,
  getSession: jest.fn(),
}));
jest.mock("../../lib/documents/storage-verify", () => ({
  __esModule: true,
  createSignedStorageUrl: jest.fn(),
  verifyDirectUploadedObject: jest.fn(),
}));
jest.mock("../../lib/rate-limit", () => ({
  __esModule: true,
  applyRateLimit: jest.fn().mockResolvedValue(null),
  documentReviewLimiter: {},
  documentUploadLimiter: {},
  documentUploadUrlLimiter: {},
  documentCommitLimiter: {},
}));
jest.mock("../../lib/documents/document-notify", () => ({
  __esModule: true,
  notifyDocumentAdded: jest.fn(),
  notifyDocumentReviewOutcome: jest.fn(),
}));
jest.mock("../../lib/supabase-storage-core", () => ({
  __esModule: true,
  deleteAppointmentDocument: jest.fn().mockResolvedValue(true),
}));
jest.mock("../../lib/prisma", () => {
  const db = {
    appointment: { findFirst: jest.fn() },
    appointmentDocument: {
      findFirst: jest.fn(),
      updateMany: jest.fn(),
      count: jest.fn(),
    },
    $executeRaw: jest.fn().mockResolvedValue(1),
    $transaction: jest.fn(),
  };
  db.$transaction.mockImplementation((fn: (tx: unknown) => unknown) => fn(db));
  return { __esModule: true, default: db };
});

const DAY = 24 * 60 * 60 * 1000;
const person = (id: string) => ({
  id: `p-${id}`,
  userId: id,
  user: { name: id },
});

/** A consultation between learner `l` and expert `e`. */
function booking(status: string, sessionEndsInDays = 3) {
  const endsAt = new Date(Date.now() + sessionEndsInDays * DAY);
  return {
    id: "apt-1",
    organizationId: null,
    organization: null,
    consultation: {
      status,
      cancelledAt: status === "CANCELLED" ? new Date() : null,
      updatedAt: new Date(),
      requestedBy: person("l"),
      consultationPlan: {
        title: "Mock interview",
        consultantProfile: person("e"),
      },
    },
    subscription: null,
    trial: null,
    occurrences: [{ startsAt: new Date(endsAt.getTime() - 3600_000), endsAt }],
    statusHistory: [],
  };
}

const params = (documentId = "doc-1") => ({
  params: Promise.resolve({ appointmentId: "apt-1", documentId }),
});
const signedIn = (id: string) =>
  (getSession as jest.Mock).mockResolvedValue({ user: { id } });

beforeEach(() => {
  jest.clearAllMocks();
});

describe("one party resolver", () => {
  it("resolves learner and expert, and nobody else", async () => {
    (prisma.appointment.findFirst as jest.Mock).mockResolvedValue(
      booking("APPROVED"),
    );
    expect((await resolveDocumentParty(prisma, "apt-1", "l"))?.role).toBe(
      "learner",
    );
    expect((await resolveDocumentParty(prisma, "apt-1", "e"))?.role).toBe(
      "expert",
    );
    const where = (prisma.appointment.findFirst as jest.Mock).mock.calls[0][0]
      .where;
    expect(where).toMatchObject({ id: "apt-1", deletedAt: null });
    expect(where.OR).toContainEqual({
      trial: { consulteeProfile: { userId: "l" } },
    });
  });
});

describe("upload commit", () => {
  it("replays a committed upload with 200 and no second notification", async () => {
    signedIn("l");
    (prisma.appointment.findFirst as jest.Mock).mockResolvedValue(
      booking("APPROVED"),
    );
    (prisma.appointmentDocument.findFirst as jest.Mock).mockResolvedValue({
      id: "doc-1",
      rootDocumentId: null,
      versionNo: 1,
    });

    const res = await uploadDocument(
      new Request("http://localhost/x", {
        method: "POST",
        body: JSON.stringify({
          storagePath: "appointments/apt-1/consultee-p-l/a.pdf",
          originalName: "a.pdf",
          mimeType: "application/pdf",
          fileSize: 1000,
        }),
      }),
      { params: Promise.resolve({ appointmentId: "apt-1" }) },
    );

    expect(res.status).toBe(200);
    expect(notifyDocumentAdded).not.toHaveBeenCalled();
    expect(await res.json()).toMatchObject({
      document: { id: "doc-1", rootId: "doc-1", versionNo: 1 },
    });
  });
});

describe("download", () => {
  it("keeps a cancelled booking's files readable for its parties", async () => {
    signedIn("l");
    (prisma.appointmentDocument.findFirst as jest.Mock).mockResolvedValue({
      appointmentId: "apt-1",
      storagePath: "appointments/apt-1/consultee-p-l/a.pdf",
      originalName: "a.pdf",
      mimeType: "application/pdf",
      isStorageMissing: false,
      uploadedByRole: "CONSULTEE",
    });
    (prisma.appointment.findFirst as jest.Mock).mockResolvedValue(
      booking("CANCELLED"),
    );
    (createSignedStorageUrl as jest.Mock).mockResolvedValue({
      ok: true,
      signedUrl: "https://storage/a.pdf?token=1",
    });
    const res = await downloadDocument(
      new Request(
        "http://localhost/api/appointments/apt-1/documents/doc-1/download?format=json",
      ),
      params(),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(createSignedStorageUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        expiresInSeconds: 60,
        disposition: "attachment",
      }),
    );
  });

  it("answers a non-party with a coded 404", async () => {
    signedIn("stranger");
    (prisma.appointmentDocument.findFirst as jest.Mock).mockResolvedValue({
      appointmentId: "apt-1",
      storagePath: "x",
      originalName: "a.pdf",
      mimeType: "application/pdf",
      isStorageMissing: false,
      uploadedByRole: "CONSULTEE",
    });
    (prisma.appointment.findFirst as jest.Mock).mockResolvedValue(null);
    const res = await downloadDocument(
      new Request("http://localhost/x?format=json"),
      params(),
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("DELETE binds the action to the caller's side", () => {
  it("lets an expert delete only a file they shared", async () => {
    signedIn("e");
    (prisma.appointment.findFirst as jest.Mock).mockResolvedValue(
      booking("APPROVED"),
    );
    (prisma.appointmentDocument.updateMany as jest.Mock).mockResolvedValue({
      count: 0,
    });
    const res = await deleteDocument(
      new Request("http://localhost/x"),
      params(),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "DOCUMENT_NOT_DELETABLE" });
    expect(
      (prisma.appointmentDocument.updateMany as jest.Mock).mock.calls[0][0]
        .where,
    ).toMatchObject({ uploadedByRole: "CONSULTANT", rootDocumentId: null });
  });

  it("lets a learner withdraw only the latest pending version", async () => {
    signedIn("l");
    (prisma.appointment.findFirst as jest.Mock).mockResolvedValue(
      booking("APPROVED"),
    );
    (prisma.appointmentDocument.findFirst as jest.Mock).mockResolvedValue({
      rootDocumentId: "root-1",
      versionNo: 3,
    });
    (prisma.appointmentDocument.updateMany as jest.Mock).mockResolvedValue({
      count: 1,
    });
    const res = await deleteDocument(
      new Request("http://localhost/x"),
      params("v3"),
    );
    expect(res.status).toBe(200);
    const { where, data } = (prisma.appointmentDocument.updateMany as jest.Mock)
      .mock.calls[0][0];
    expect(where).toMatchObject({
      uploadedByRole: "CONSULTEE",
      reviewStatus: "PENDING",
      rootDocument: {
        is: {
          threadVersions: { none: { deletedAt: null, versionNo: { gt: 3 } } },
        },
      },
    });
    expect(data).toMatchObject({ removalReason: "USER_REQUEST" });
  });

  it("refuses writes once the upload window has closed", async () => {
    signedIn("l");
    (prisma.appointment.findFirst as jest.Mock).mockResolvedValue(
      booking("COMPLETED", -40),
    );
    const res = await deleteDocument(
      new Request("http://localhost/x"),
      params(),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "UPLOAD_WINDOW_CLOSED" });
  });
});

describe("review", () => {
  const post = (body: unknown) =>
    reviewDocument(
      new Request("http://localhost/x", {
        method: "POST",
        body: JSON.stringify(body),
      }),
      params(),
    );

  it("is refused for the learner", async () => {
    signedIn("l");
    (prisma.appointment.findFirst as jest.Mock).mockResolvedValue(
      booking("APPROVED"),
    );
    const res = await post({ reviewStatus: "APPROVED" });
    expect(res.status).toBe(403);
  });

  it("answers SUPERSEDED when the learner uploaded a newer version", async () => {
    signedIn("e");
    (prisma.appointment.findFirst as jest.Mock).mockResolvedValue(
      booking("APPROVED"),
    );
    (prisma.appointmentDocument.findFirst as jest.Mock).mockImplementation(
      async ({ where }: { where: { reviewStatus?: string } }) =>
        where.reviewStatus && where.reviewStatus !== "PENDING"
          ? null
          : {
              id: "doc-1",
              originalName: "cv.pdf",
              rootDocumentId: null,
              versionNo: 1,
              reviewStatus: "PENDING",
            },
    );
    (prisma.appointmentDocument.count as jest.Mock).mockResolvedValue(1);
    const res = await post({ reviewStatus: "APPROVED" });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "SUPERSEDED" });
    expect(prisma.appointmentDocument.updateMany).not.toHaveBeenCalled();
  });

  it("answers a retried approval as the first write did, without a second write", async () => {
    signedIn("e");
    (prisma.appointment.findFirst as jest.Mock).mockResolvedValue(
      booking("APPROVED"),
    );
    (prisma.appointmentDocument.findFirst as jest.Mock).mockResolvedValue({
      id: "doc-1",
      originalName: "cv.pdf",
      rootDocumentId: null,
      versionNo: 1,
      reviewStatus: "APPROVED",
      reviewNotes: null,
    });
    (prisma.appointmentDocument.count as jest.Mock).mockResolvedValue(0);
    const res = await post({ reviewStatus: "APPROVED" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      document: { id: "doc-1", reviewStatus: "APPROVED" },
      reply: null,
    });
    expect(prisma.appointmentDocument.updateMany).not.toHaveBeenCalled();
  });

  it("answers SUPERSEDED to a retried approval once the learner uploaded a newer version", async () => {
    signedIn("e");
    (prisma.appointment.findFirst as jest.Mock).mockResolvedValue(
      booking("APPROVED"),
    );
    (prisma.appointmentDocument.findFirst as jest.Mock).mockResolvedValue({
      id: "doc-1",
      originalName: "cv.pdf",
      rootDocumentId: null,
      versionNo: 1,
      reviewStatus: "APPROVED",
      reviewNotes: null,
    });
    (prisma.appointmentDocument.count as jest.Mock).mockResolvedValue(1);
    const res = await post({ reviewStatus: "APPROVED" });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "SUPERSEDED" });
    expect(prisma.appointmentDocument.updateMany).not.toHaveBeenCalled();
  });

  it("replays a committed reply without re-verifying storage", async () => {
    signedIn("e");
    (prisma.appointment.findFirst as jest.Mock).mockResolvedValue(
      booking("APPROVED"),
    );
    (prisma.appointmentDocument.findFirst as jest.Mock)
      .mockResolvedValueOnce({ id: "reply-1" })
      .mockResolvedValueOnce({
        id: "reply-1",
        originalName: "reply.pdf",
        rootDocumentId: "doc-1",
        versionNo: 1,
      })
      .mockResolvedValueOnce({
        id: "doc-1",
        originalName: "cv.pdf",
        rootDocumentId: null,
        versionNo: 1,
        reviewStatus: "PENDING",
      });

    const res = await post({
      reply: {
        storagePath: "appointments/apt-1/consultant-p-e/reply.pdf",
        originalName: "reply.pdf",
        mimeType: "application/pdf",
        fileSize: 1000,
      },
    });

    expect(res.status).toBe(200);
    expect(verifyDirectUploadedObject).not.toHaveBeenCalled();
    expect(notifyDocumentAdded).not.toHaveBeenCalled();
    expect(await res.json()).toMatchObject({
      document: { id: "doc-1", reviewStatus: "PENDING" },
      reply: { id: "reply-1", versionNo: 1 },
    });
  });

  it("writes the status with the prior status in the WHERE", async () => {
    signedIn("e");
    (prisma.appointment.findFirst as jest.Mock).mockResolvedValue(
      booking("APPROVED"),
    );
    (prisma.appointmentDocument.findFirst as jest.Mock).mockResolvedValue({
      id: "doc-1",
      originalName: "cv.pdf",
      rootDocumentId: null,
      versionNo: 1,
      reviewStatus: "PENDING",
    });
    (prisma.appointmentDocument.count as jest.Mock).mockResolvedValue(0);
    (prisma.appointmentDocument.updateMany as jest.Mock).mockResolvedValue({
      count: 1,
    });
    const res = await post({
      reviewStatus: "NEEDS_REVISION",
      reviewNotes: "Tighten",
    });
    expect(res.status).toBe(200);
    expect(
      (prisma.appointmentDocument.updateMany as jest.Mock).mock.calls[0][0]
        .where,
    ).toMatchObject({ id: "doc-1", reviewStatus: "PENDING", deletedAt: null });
  });
});
