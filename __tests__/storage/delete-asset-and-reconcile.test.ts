/**
 * @jest-environment node
 *
 * Unit tests for admin storage deletion (removeObjects / deleteAsset),
 * private support attachment routes, and prefix-safe orphan reconciliation
 * across documents & support-attachments buckets.
 */

const mockAnonRemove = jest.fn();
const mockAdminRemove = jest.fn();
const mockAdminExists = jest.fn();
const mockAdminList = jest.fn();

jest.mock("@supabase/supabase-js", () => {
  process.env.NEXT_PUBLIC_SUPABASE_URL ||= "https://example.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= "anon-key";
  process.env.SUPABASE_SERVICE_ROLE_KEY ||= "service-role-key";

  return {
    createClient: jest.fn((_url: string, key: string) => {
      if (key === process.env.SUPABASE_SERVICE_ROLE_KEY) {
        return {
          storage: {
            from: (bucket: string) => ({
              remove: (paths: string[]) => mockAdminRemove(bucket, paths),
              exists: (path: string) => mockAdminExists(bucket, path),
              list: (path = "") => mockAdminList(bucket, path),
            }),
          },
        };
      }
      return {
        storage: {
          from: () => ({
            remove: mockAnonRemove,
          }),
        },
      };
    }),
  };
});

const mockUploadSupportTicketAttachment = jest.fn();
const mockDeleteSupportTicketAttachment = jest.fn();
const mockCreateSupportAttachmentSignedUrl = jest.fn();

jest.mock("../../lib/supabase", () => ({
  uploadSupportTicketAttachment: (...args: unknown[]) =>
    mockUploadSupportTicketAttachment(...args),
  deleteSupportTicketAttachment: (...args: unknown[]) =>
    mockDeleteSupportTicketAttachment(...args),
  createSupportAttachmentSignedUrl: (...args: unknown[]) =>
    mockCreateSupportAttachmentSignedUrl(...args),
  getManualBucketInstructions: () => "instructions",
}));

const mockAppointmentDocFindMany = jest.fn();
const mockAppointmentDocUpdateMany = jest.fn();
const mockSupportAttachmentFindMany = jest.fn();
const mockSupportAttachmentFindUnique = jest.fn();
const mockSupportAttachmentDelete = jest.fn();
const mockSupportAttachmentCount = jest.fn();
const mockSupportAttachmentCreate = jest.fn();
const mockSupportTicketFindUnique = jest.fn();
const mockUserFindUnique = jest.fn();

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    appointmentDocument: {
      findMany: (...args: unknown[]) => mockAppointmentDocFindMany(...args),
      updateMany: (...args: unknown[]) => mockAppointmentDocUpdateMany(...args),
    },
    supportTicketAttachment: {
      findMany: (...args: unknown[]) => mockSupportAttachmentFindMany(...args),
      findUnique: (...args: unknown[]) =>
        mockSupportAttachmentFindUnique(...args),
      delete: (...args: unknown[]) => mockSupportAttachmentDelete(...args),
      count: (...args: unknown[]) => mockSupportAttachmentCount(...args),
      create: (...args: unknown[]) => mockSupportAttachmentCreate(...args),
    },
    supportTicket: {
      findUnique: (...args: unknown[]) => mockSupportTicketFindUnique(...args),
    },
    user: {
      findUnique: (...args: unknown[]) => mockUserFindUnique(...args),
    },
    $transaction: async (
      fn: (tx: Record<string, unknown>) => Promise<unknown>,
    ) =>
      fn({
        $queryRaw: jest.fn().mockResolvedValue([{ id: "ticket-1" }]),
        supportTicketAttachment: {
          count: (...args: unknown[]) => mockSupportAttachmentCount(...args),
          create: (...args: unknown[]) => mockSupportAttachmentCreate(...args),
        },
      }),
    $disconnect: jest.fn(),
  },
}));

jest.mock("../../lib/cron/with-cron-lock", () => ({
  LONG_JOB_TTL_MS: 600_000,
  withCronLock: (_name: string, _opts: unknown, fn: () => Promise<unknown>) =>
    fn(),
}));

const mockGetSession = jest.fn();
jest.mock("../../lib/auth-server", () => ({
  getSession: (...args: unknown[]) => mockGetSession(...args),
}));

jest.mock("../../lib/rate-limit", () => ({
  spamLimiter: {},
  applyRateLimit: jest.fn().mockResolvedValue(null),
}));

const mockReportSentryError = jest.fn();
jest.mock("../../lib/observability/report", () => ({
  reportSentryError: (...args: unknown[]) => mockReportSentryError(...args),
}));

import { NextRequest } from "next/server";
import { deleteAsset, removeObjects } from "../../lib/supabase-storage-core";
import { reconcileDocumentStorage } from "../../scripts/cleanup/reconcile-document-storage";
import {
  DELETE as deleteAttachmentRoute,
  GET as getAttachmentsListRoute,
  POST as postAttachmentRoute,
} from "../../app/api/support-tickets/[ticketId]/attachments/route";
import { GET as getAttachmentRedirectRoute } from "../../app/api/support-tickets/[ticketId]/attachments/[attachmentId]/route";

describe("removeObjects / deleteAsset (supabaseAdmin + .exists() verification)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("uses supabaseAdmin (never anon client) and succeeds when all paths are removed", async () => {
    mockAdminRemove.mockResolvedValue({
      data: [{ name: "support-tickets/t1/a.pdf" }],
      error: null,
    });

    const ok = await deleteAsset(
      "support-attachments",
      "support-tickets/t1/a.pdf",
    );

    expect(ok).toBe(true);
    expect(mockAnonRemove).not.toHaveBeenCalled();
    expect(mockAdminRemove).toHaveBeenCalledWith("support-attachments", [
      "support-tickets/t1/a.pdf",
    ]);
    expect(mockAdminExists).not.toHaveBeenCalled();
  });

  it("returns true on partial remove when missing paths do not exist (idempotent re-run)", async () => {
    mockAdminRemove.mockResolvedValue({
      data: [{ name: "support-tickets/t1/present.pdf" }],
      error: null,
    });
    mockAdminExists.mockResolvedValue({ data: false, error: null });

    const ok = await removeObjects("support-attachments", [
      "support-tickets/t1/present.pdf",
      "support-tickets/t1/already-gone.pdf",
    ]);

    expect(ok).toBe(true);
    expect(mockAdminExists).toHaveBeenCalledTimes(1);
    expect(mockAdminExists).toHaveBeenCalledWith(
      "support-attachments",
      "support-tickets/t1/already-gone.pdf",
    );
  });

  it("returns false on partial remove when an unremoved object still exists in storage", async () => {
    mockAdminRemove.mockResolvedValue({
      data: [],
      error: null,
    });
    mockAdminExists.mockResolvedValue({ data: true, error: null });

    const ok = await removeObjects("support-attachments", [
      "support-tickets/t1/stuck.pdf",
    ]);

    expect(ok).toBe(false);
    expect(mockAdminExists).toHaveBeenCalledWith(
      "support-attachments",
      "support-tickets/t1/stuck.pdf",
    );
  });
});

describe("Support attachment routes (private URL storage, 502 guard on storage delete failure, 302 redirect)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("GET enforces auth/access and lists attachments for ticket owner", async () => {
    const req = new NextRequest(
      "http://localhost:3000/api/support-tickets/ticket-1/attachments",
    );

    mockGetSession.mockResolvedValueOnce(null);
    expect(
      (
        await getAttachmentsListRoute(req, {
          params: Promise.resolve({ ticketId: "ticket-1" }),
        })
      ).status,
    ).toBe(401);

    mockGetSession.mockResolvedValueOnce({ user: { id: "stranger" } });
    mockUserFindUnique.mockResolvedValueOnce({ role: "CONSULTEE" });
    mockSupportTicketFindUnique.mockResolvedValueOnce({ userId: "owner-1" });
    expect(
      (
        await getAttachmentsListRoute(req, {
          params: Promise.resolve({ ticketId: "ticket-1" }),
        })
      ).status,
    ).toBe(403);

    mockGetSession.mockResolvedValueOnce({ user: { id: "owner-1" } });
    mockUserFindUnique.mockResolvedValueOnce({ role: "CONSULTEE" });
    mockSupportTicketFindUnique.mockResolvedValueOnce({ userId: "owner-1" });
    mockSupportAttachmentFindMany.mockResolvedValueOnce([{ id: "att-1" }]);
    expect(
      (
        await getAttachmentsListRoute(req, {
          params: Promise.resolve({ ticketId: "ticket-1" }),
        })
      ).status,
    ).toBe(200);
  });

  it("POST enforces validation and stores pre-allocated app redirect URL", async () => {
    mockGetSession.mockResolvedValue({ user: { id: "owner-1" } });
    mockUserFindUnique.mockResolvedValue({ role: "CONSULTEE" });

    mockSupportTicketFindUnique.mockResolvedValueOnce({
      userId: "owner-1",
      status: "CLOSED",
    });
    const closedReq = new NextRequest(
      "http://localhost:3000/api/support-tickets/ticket-1/attachments",
      { method: "POST" },
    );
    expect(
      (
        await postAttachmentRoute(closedReq, {
          params: Promise.resolve({ ticketId: "ticket-1" }),
        })
      ).status,
    ).toBe(400);

    mockSupportTicketFindUnique.mockResolvedValue({
      userId: "owner-1",
      status: "OPEN",
    });
    mockSupportAttachmentCount.mockResolvedValue(0);
    mockUploadSupportTicketAttachment.mockResolvedValue({
      success: true,
      fileName: "generated.pdf",
      fileSize: 5,
      mimeType: "application/pdf",
      storagePath: "support-tickets/ticket-1/generated.pdf",
    });
    mockSupportAttachmentCreate.mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) => data,
    );

    const formData = new FormData();
    formData.set(
      "file",
      new File(["hello"], "evidence.pdf", { type: "application/pdf" }),
    );
    const req = new NextRequest(
      "http://localhost:3000/api/support-tickets/ticket-1/attachments",
      { method: "POST", body: formData },
    );

    const res = await postAttachmentRoute(req, {
      params: Promise.resolve({ ticketId: "ticket-1" }),
    });
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.attachment.fileUrl).toBe(
      `/api/support-tickets/ticket-1/attachments/${body.attachment.id}`,
    );
  });

  it("DELETE returns 502 when storage deletion returns false or throws, and deletes DB row on success", async () => {
    mockGetSession.mockResolvedValue({ user: { id: "owner-1" } });
    mockUserFindUnique.mockResolvedValue({ role: "CONSULTEE" });

    const missingIdReq = new NextRequest(
      "http://localhost:3000/api/support-tickets/ticket-1/attachments",
      { method: "DELETE", body: JSON.stringify({}) },
    );
    expect(
      (
        await deleteAttachmentRoute(missingIdReq, {
          params: Promise.resolve({ ticketId: "ticket-1" }),
        })
      ).status,
    ).toBe(400);

    mockSupportAttachmentFindUnique.mockResolvedValue({
      id: "att-1",
      ticketId: "ticket-1",
      storagePath: "support-tickets/ticket-1/att.pdf",
      ticket: { userId: "owner-1", status: "OPEN" },
    });
    mockDeleteSupportTicketAttachment.mockResolvedValueOnce(false);

    const req = new NextRequest(
      "http://localhost:3000/api/support-tickets/ticket-1/attachments",
      {
        method: "DELETE",
        body: JSON.stringify({ attachmentId: "att-1" }),
      },
    );

    const res = await deleteAttachmentRoute(req, {
      params: Promise.resolve({ ticketId: "ticket-1" }),
    });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: "Failed to remove attachment from storage",
    });
    expect(mockReportSentryError).toHaveBeenCalledTimes(1);
    expect(mockSupportAttachmentDelete).not.toHaveBeenCalled();

    mockDeleteSupportTicketAttachment.mockRejectedValueOnce(
      new Error("storage down"),
    );
    const reqThrow = new NextRequest(
      "http://localhost:3000/api/support-tickets/ticket-1/attachments",
      {
        method: "DELETE",
        body: JSON.stringify({ attachmentId: "att-1" }),
      },
    );
    const resThrow = await deleteAttachmentRoute(reqThrow, {
      params: Promise.resolve({ ticketId: "ticket-1" }),
    });
    expect(resThrow.status).toBe(502);
    expect(mockReportSentryError).toHaveBeenCalledTimes(2);
    expect(mockSupportAttachmentDelete).not.toHaveBeenCalled();

    mockDeleteSupportTicketAttachment.mockResolvedValueOnce(true);
    mockSupportAttachmentDelete.mockResolvedValueOnce({ id: "att-1" });
    const reqOk = new NextRequest(
      "http://localhost:3000/api/support-tickets/ticket-1/attachments",
      {
        method: "DELETE",
        body: JSON.stringify({ attachmentId: "att-1" }),
      },
    );
    const resOk = await deleteAttachmentRoute(reqOk, {
      params: Promise.resolve({ ticketId: "ticket-1" }),
    });
    expect(resOk.status).toBe(200);
    expect(mockSupportAttachmentDelete).toHaveBeenCalledWith({
      where: { id: "att-1" },
    });
  });

  it("GET /attachments/[attachmentId] enforces auth/ownership and redirects authorized caller with 302 + private, no-store", async () => {
    const req = new NextRequest(
      "http://localhost:3000/api/support-tickets/ticket-1/attachments/att-1",
    );

    mockGetSession.mockResolvedValueOnce(null);
    const unauth = await getAttachmentRedirectRoute(req, {
      params: Promise.resolve({ ticketId: "ticket-1", attachmentId: "att-1" }),
    });
    expect(unauth.status).toBe(401);

    mockGetSession.mockResolvedValueOnce({ user: { id: "other-user" } });
    mockUserFindUnique.mockResolvedValueOnce({ role: "CONSULTEE" });
    mockSupportAttachmentFindUnique.mockResolvedValueOnce({
      ticketId: "ticket-1",
      storagePath: "support-tickets/ticket-1/att.pdf",
      ticket: { userId: "owner-1" },
    });
    const forbidden = await getAttachmentRedirectRoute(req, {
      params: Promise.resolve({ ticketId: "ticket-1", attachmentId: "att-1" }),
    });
    expect(forbidden.status).toBe(403);

    mockGetSession.mockResolvedValueOnce({ user: { id: "staff-1" } });
    mockUserFindUnique.mockResolvedValueOnce({ role: "STAFF" });
    mockSupportAttachmentFindUnique.mockResolvedValueOnce({
      ticketId: "ticket-1",
      storagePath: "support-tickets/ticket-1/att.pdf",
      ticket: { userId: "owner-1" },
    });
    mockCreateSupportAttachmentSignedUrl.mockResolvedValueOnce(
      "https://example.supabase.co/signed/att.pdf?token=x",
    );

    const res = await getAttachmentRedirectRoute(req, {
      params: Promise.resolve({ ticketId: "ticket-1", attachmentId: "att-1" }),
    });

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "https://example.supabase.co/signed/att.pdf?token=x",
    );
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(mockCreateSupportAttachmentSignedUrl).toHaveBeenCalledWith(
      "support-tickets/ticket-1/att.pdf",
      60,
    );
  });
});

describe("reconcileDocumentStorage prefix safety & support-attachments sweep", () => {
  const tenDaysAgo = new Date(
    Date.now() - 10 * 24 * 60 * 60 * 1000,
  ).toISOString();
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("never flags plans/ or verifications/ in documents bucket, and deletes stale orphans across appointments/ and support-attachments", async () => {
    const bucketTree: Record<
      string,
      Array<{
        name: string;
        created_at?: string;
        metadata?: Record<string, unknown> | null;
      }>
    > = {
      "documents:": [
        { name: "appointments", metadata: null },
        { name: "plans", metadata: null },
        { name: "verifications", metadata: null },
      ],
      "documents:appointments": [
        { name: "kept.pdf", created_at: tenDaysAgo, metadata: { size: 100 } },
        {
          name: "stale-orphan.pdf",
          created_at: tenDaysAgo,
          metadata: { size: 100 },
        },
        {
          name: "recent-orphan.pdf",
          created_at: oneDayAgo,
          metadata: { size: 100 },
        },
      ],
      "documents:plans": [
        {
          name: "plan-material.pdf",
          created_at: tenDaysAgo,
          metadata: { size: 200 },
        },
      ],
      "documents:verifications": [
        {
          name: "kyc-doc.pdf",
          created_at: tenDaysAgo,
          metadata: { size: 300 },
        },
      ],
      "support-attachments:": [{ name: "support-tickets", metadata: null }],
      "support-attachments:support-tickets": [
        {
          name: "kept-att.png",
          created_at: tenDaysAgo,
          metadata: { size: 120 },
        },
        {
          name: "stale-att-orphan.png",
          created_at: tenDaysAgo,
          metadata: { size: 120 },
        },
      ],
    };

    mockAdminList.mockImplementation(async (bucket: string, path: string) => ({
      data: bucketTree[`${bucket}:${path}`] ?? [],
      error: null,
    }));
    mockAdminRemove.mockResolvedValue({ data: [], error: null });

    mockAppointmentDocFindMany.mockResolvedValue([
      {
        id: "doc-1",
        storagePath: "appointments/kept.pdf",
        isStorageMissing: false,
      },
    ]);
    mockAppointmentDocUpdateMany.mockResolvedValue({ count: 0 });
    mockSupportAttachmentFindMany.mockResolvedValue([
      {
        storagePath: "support-tickets/kept-att.png",
      },
    ]);

    const result = await reconcileDocumentStorage();

    expect(result.success).toBe(true);
    expect(result.orphanedFilesFound).toBe(3);
    expect(result.orphanedFilesDeleted).toBe(2);

    expect(mockAdminRemove).toHaveBeenCalledTimes(2);
    expect(mockAdminRemove).toHaveBeenCalledWith("documents", [
      "appointments/stale-orphan.pdf",
    ]);
    expect(mockAdminRemove).toHaveBeenCalledWith("support-attachments", [
      "support-tickets/stale-att-orphan.png",
    ]);
  });
});
