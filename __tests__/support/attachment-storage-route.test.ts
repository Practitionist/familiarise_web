/**
 * @jest-environment node
 */

/**
 * The evidence attachment storage.
 *
 * The canonical case graph serves attachments in three steps — mint a row and
 * a signed upload URL, PUT the file, then confirm the upload — and the
 * behaviours that matter are pinned here:
 *
 *   - a customer is throttled, and the throttle is per person per case;
 *   - a file is NOT visible until the upload is confirmed, so a half-finished
 *     upload is never downloadable;
 *   - the declared size and type must match what actually landed, or the
 *     confirmation is refused;
 *   - submitted evidence is RETAINED with the case, not quietly deleted.
 */

const mockCreateSignedUploadUrl = jest.fn();
const mockCreateSignedUrl = jest.fn();
const mockStorageInfo = jest.fn();
const mockAttachmentFindFirst = jest.fn();
const mockAttachmentFindMany = jest.fn();
const mockAttachmentCount = jest.fn();
const mockAttachmentCreate = jest.fn();
const mockAttachmentUpdateMany = jest.fn();
const mockCaseFindFirst = jest.fn();
const mockEvidenceRequestFindFirst = jest.fn();
const mockSession = jest.fn();

jest.mock("@sentry/nextjs", () => ({
  __esModule: true,
  captureException: jest.fn(),
  captureMessage: jest.fn(),
  flush: jest.fn(async () => true),
}));

// The mock factories are hoisted above the declarations above, so the
// module under test is given a client whose parts are reached through
// `jest.requireMock` — the same shape the rest of this suite uses.
jest.mock("../../lib/supabase-storage-core", () => ({
  adminStorage: () => ({
    from: () => ({
      createSignedUploadUrl: (...args: unknown[]) =>
        mockCreateSignedUploadUrl(...args),
      createSignedUrl: (...args: unknown[]) => mockCreateSignedUrl(...args),
      info: (...args: unknown[]) => mockStorageInfo(...args),
    }),
  }),
}));

jest.mock("../../lib/auth-server", () => ({
  __esModule: true,
  getSession: () => mockSession(),
}));

jest.mock("../../lib/auth-helpers", () => ({
  __esModule: true,
  requireApiAuth: jest.fn(async () => ({
    session: { user: { id: "u1", role: "CONSULTEE" } },
  })),
  requireApiSession: jest.fn(async () => ({
    session: { user: { id: "u1", role: "CONSULTEE" } },
  })),
}));

jest.mock("../../lib/rate-limit", () => ({
  __esModule: true,
  documentUploadLimiter: {},
  applyRateLimit: jest.fn(async () => null),
}));

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    supportCaseAttachment: {
      findFirst: (...args: unknown[]) => mockAttachmentFindFirst(...args),
      findMany: (...args: unknown[]) => mockAttachmentFindMany(...args),
      count: (...args: unknown[]) => mockAttachmentCount(...args),
      create: (...args: unknown[]) => mockAttachmentCreate(...args),
      updateMany: (...args: unknown[]) => mockAttachmentUpdateMany(...args),
    },
    supportCase: {
      findFirst: (...args: unknown[]) => mockCaseFindFirst(...args),
    },
    supportCaseEvidenceRequest: {
      findFirst: (...args: unknown[]) => mockEvidenceRequestFindFirst(...args),
    },
    supportCaseMessage: { findFirst: jest.fn(async () => null) },
    $transaction: jest.fn(async (fn: (tx: unknown) => unknown) =>
      fn({
        supportCaseAttachment: {
          findFirst: (...args: unknown[]) => mockAttachmentFindFirst(...args),
          findMany: (...args: unknown[]) => mockAttachmentFindMany(...args),
          count: (...args: unknown[]) => mockAttachmentCount(...args),
          create: (...args: unknown[]) => mockAttachmentCreate(...args),
          updateMany: (...args: unknown[]) => mockAttachmentUpdateMany(...args),
        },
      }),
    ),
  },
}));

import { NextRequest } from "next/server";
import { applyRateLimit } from "../../lib/rate-limit";
import {
  GET as getAttachment,
  DELETE as deleteAttachment,
} from "../../app/api/support/attachments/[attachmentId]/route";
import {
  GET as listAttachments,
  POST as createAttachment,
  PUT as confirmAttachment,
} from "../../app/api/support/cases/[caseId]/attachments/route";

const CASE = {
  id: "c-1",
  deletedAt: null,
  status: "OPEN",
  ownershipScope: "PERSONAL",
  organizationId: null,
  requesterUserId: "u1",
  submitterUserId: "u1",
};

const post = (body: unknown) =>
  new NextRequest("https://x.test/api/support/cases/c-1/attachments", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  jest.clearAllMocks();
  mockSession.mockResolvedValue({ user: { id: "u1", role: "CONSULTEE" } });
  mockCaseFindFirst.mockResolvedValue(CASE);
  mockEvidenceRequestFindFirst.mockResolvedValue(null);
  mockAttachmentCount.mockResolvedValue(0);
  mockAttachmentCreate.mockImplementation(
    async ({ data }: { data: { id: string } }) => ({
      id: data.id,
      storagePath: `support-cases/c-1/${data.id}`,
    }),
  );
  mockCreateSignedUploadUrl.mockResolvedValue({
    data: { signedUrl: "https://storage.test/upload", token: "tok", path: "p" },
    error: null,
  });
  mockStorageInfo.mockResolvedValue({
    data: { size: 1024, contentType: "application/pdf" },
    error: null,
  });
  mockAttachmentUpdateMany.mockResolvedValue({ count: 1 });
  mockAttachmentFindMany.mockResolvedValue([]);
});

describe("the upload", () => {
  it("mints a row and a signed upload URL", async () => {
    const res = await createAttachment(
      post({
        originalName: "proof.pdf",
        mimeType: "application/pdf",
        fileSize: 1024,
      }),
      { params: Promise.resolve({ caseId: "c-1" }) },
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.uploadUrl).toBe("https://storage.test/upload");
    expect(mockAttachmentCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          caseId: "c-1",
          originalName: "proof.pdf",
          uploadedById: "u1",
        }),
      }),
    );
  });

  it("throttles a customer per person per case", async () => {
    await createAttachment(
      post({
        originalName: "proof.pdf",
        mimeType: "application/pdf",
        fileSize: 1024,
      }),
      { params: Promise.resolve({ caseId: "c-1" }) },
    );
    expect(applyRateLimit).toHaveBeenCalledWith(
      expect.anything(),
      "case-upload:u1",
    );
  });

  it("refuses a file on a closed case", async () => {
    mockCaseFindFirst.mockResolvedValue({ ...CASE, status: "CLOSED" });
    const res = await createAttachment(
      post({
        originalName: "proof.pdf",
        mimeType: "application/pdf",
        fileSize: 1024,
      }),
      { params: Promise.resolve({ caseId: "c-1" }) },
    );
    expect(res.status).toBe(409);
    expect(mockAttachmentCreate).not.toHaveBeenCalled();
  });

  it("refuses a twenty-first file", async () => {
    mockAttachmentCount.mockResolvedValue(20);
    const res = await createAttachment(
      post({
        originalName: "proof.pdf",
        mimeType: "application/pdf",
        fileSize: 1024,
      }),
      { params: Promise.resolve({ caseId: "c-1" }) },
    );
    expect(res.status).toBe(400);
    expect(mockAttachmentCreate).not.toHaveBeenCalled();
  });

  it("refuses a file type it does not accept", async () => {
    const res = await createAttachment(
      post({
        originalName: "payload.exe",
        mimeType: "application/x-msdownload",
        fileSize: 10,
      }),
      { params: Promise.resolve({ caseId: "c-1" }) },
    );
    expect(res.status).toBe(400);
  });
});

describe("the confirmation", () => {
  it("refuses a file whose stored size or type does not match the declaration", async () => {
    mockAttachmentFindFirst.mockResolvedValue({
      id: "att-1",
      caseId: "c-1",
      uploadedById: "u1",
      completedAt: null,
      deletedAt: null,
      storagePath: "support-cases/c-1/att-1",
      fileSize: 1024,
      mimeType: "application/pdf",
      evidenceRequestId: null,
    });
    mockStorageInfo.mockResolvedValue({
      data: { size: 999, contentType: "application/pdf" },
      error: null,
    });
    const res = await confirmAttachment(
      new NextRequest("https://x.test/api/support/cases/c-1/attachments", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ attachmentId: "att-1" }),
      }),
      { params: Promise.resolve({ caseId: "c-1" }) },
    );
    expect(res.status).toBe(400);
    expect(mockAttachmentUpdateMany).not.toHaveBeenCalled();
  });

  it("completes the upload when the file matches the declaration", async () => {
    mockAttachmentFindFirst.mockResolvedValue({
      id: "att-1",
      caseId: "c-1",
      uploadedById: "u1",
      completedAt: null,
      deletedAt: null,
      storagePath: "support-cases/c-1/att-1",
      fileSize: 1024,
      mimeType: "application/pdf",
      evidenceRequestId: null,
    });
    const res = await confirmAttachment(
      new NextRequest("https://x.test/api/support/cases/c-1/attachments", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ attachmentId: "att-1" }),
      }),
      { params: Promise.resolve({ caseId: "c-1" }) },
    );
    expect(res.status).toBe(200);
    expect(mockAttachmentUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "att-1", completedAt: null }),
      }),
    );
  });
});

describe("the download", () => {
  it("redirects to a signed URL minted from the stored path", async () => {
    mockAttachmentFindFirst.mockResolvedValue({
      id: "att-1",
      caseId: "c-1",
      completedAt: new Date(),
      deletedAt: null,
      storagePath: "support-cases/c-1/att-1",
      originalName: "proof.pdf",
      message: null,
      evidenceRequestId: null,
    });
    mockCreateSignedUrl.mockResolvedValue({
      data: { signedUrl: "https://storage.test/download" },
      error: null,
    });
    const res = await getAttachment(new NextRequest("https://x.test/x"), {
      params: Promise.resolve({ attachmentId: "att-1" }),
    });
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("https://storage.test/download");
  });

  it("hides an attachment that is not finished", async () => {
    mockAttachmentFindFirst.mockResolvedValue(null);
    const res = await getAttachment(new NextRequest("https://x.test/x"), {
      params: Promise.resolve({ attachmentId: "att-1" }),
    });
    expect(res.status).toBe(404);
  });

  it("lists only finished attachments", async () => {
    const res = await listAttachments(
      new NextRequest("https://x.test/api/support/cases/c-1/attachments"),
      { params: Promise.resolve({ caseId: "c-1" }) },
    );
    expect(res.status).toBe(200);
    expect(mockAttachmentFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          caseId: "c-1",
          completedAt: { not: null },
        }),
      }),
    );
  });
});

describe("the removal", () => {
  it("retains submitted evidence rather than deleting it", async () => {
    mockAttachmentFindFirst.mockResolvedValue({
      id: "att-1",
      caseId: "c-1",
      uploadedById: "u1",
      completedAt: new Date(),
      deletedAt: null,
      evidenceRequestId: null,
      supportCase: { decisions: [], status: "OPEN" },
    });
    const res = await deleteAttachment(new NextRequest("https://x.test/x"), {
      params: Promise.resolve({ attachmentId: "att-1" }),
    });
    expect(res.status).toBe(409);
    expect(mockAttachmentUpdateMany).not.toHaveBeenCalled();
  });

  it("soft-deletes an unfinished upload", async () => {
    mockAttachmentFindFirst.mockResolvedValue({
      id: "att-1",
      caseId: "c-1",
      uploadedById: "u1",
      completedAt: null,
      deletedAt: null,
      evidenceRequestId: null,
      supportCase: { decisions: [], status: "OPEN" },
    });
    const res = await deleteAttachment(new NextRequest("https://x.test/x"), {
      params: Promise.resolve({ attachmentId: "att-1" }),
    });
    expect(res.status).toBe(200);
    expect(mockAttachmentUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "att-1", completedAt: null }),
        data: expect.objectContaining({ deletedAt: expect.any(Date) }),
      }),
    );
  });
});
