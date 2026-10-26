/** @jest-environment node */

const storage = {
  info: jest.fn(),
  createSignedUrl: jest.fn(),
};
jest.mock("../../lib/supabase-storage-core", () => ({
  __esModule: true,
  adminStorage: () => ({ from: () => storage }),
  ensureBucketExists: jest.fn(async () => true),
  removeObjects: jest.fn(async () => true),
}));
jest.mock("../../lib/auth-helpers", () => ({
  __esModule: true,
  requireApiAuth: jest.fn(async () => ({
    session: { user: { id: "uploader", role: "CONSULTEE" } },
  })),
}));
jest.mock("../../lib/rate-limit", () => ({
  __esModule: true,
  documentUploadLimiter: {},
  applyRateLimit: jest.fn(async () => null),
}));
jest.mock("../../lib/support/case-actions", () => ({
  __esModule: true,
  CaseActionError: class extends Error {},
  evidenceRecipients: jest.fn(async () => []),
}));
jest.mock("../../lib/prisma", () => {
  const db = {
    supportCase: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      updateMany: jest.fn(),
    },
    supportCaseAttachment: {
      findFirst: jest.fn(),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
    supportCaseEvidenceRequest: { findUnique: jest.fn() },
    membership: { findUnique: jest.fn() },
  };
  return {
    __esModule: true,
    default: { ...db, $transaction: jest.fn(async (fn) => fn(db)) },
  };
});

import { NextRequest } from "next/server";
import prisma from "../../lib/prisma";
import { removeObjects } from "../../lib/supabase-storage-core";
import {
  headMatchesMimeType,
  SUPPORT_ATTACHMENT_ACCEPT,
  SUPPORT_ATTACHMENT_MIME_TYPES,
} from "../../lib/support/attachment-policy";
import { SUPPORT_EVIDENCE_BUCKET_OPTIONS } from "../../lib/support/case-attachments";
import { PUT } from "../../app/api/support/cases/[caseId]/attachments/route";

const bytes = (...values: number[]) => Uint8Array.from(values);
const text = (value: string) => new TextEncoder().encode(value);

describe("support attachment magic bytes", () => {
  it.each([
    ["application/pdf", text("%PDF-1.7\n")],
    ["image/jpeg", bytes(0xff, 0xd8, 0xff, 0xe0)],
    ["image/png", bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)],
    ["image/webp", text("RIFF\u0000\u0000\u0000\u0000WEBPVP8 ")],
    [
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      bytes(0x50, 0x4b, 0x03, 0x04, 0x14),
    ],
    ["text/plain", text("Session ended early.\r\nPlease review.\t")],
  ] as const)("accepts a real %s", (mimeType, head) => {
    expect(headMatchesMimeType(head, mimeType)).toBe(true);
  });

  it.each([
    ["application/pdf", text("<html><script>")],
    ["image/png", bytes(0xff, 0xd8, 0xff)],
    ["image/webp", text("RIFF\u0000\u0000\u0000\u0000AVI ")],
    ["text/plain", bytes(0x4d, 0x5a, 0x90, 0x00)],
    ["text/plain", bytes()],
  ] as const)("rejects a %s whose bytes say otherwise", (mimeType, head) => {
    expect(headMatchesMimeType(head, mimeType)).toBe(false);
  });

  it("configures the private bucket from the same allowlist the picker uses", () => {
    expect(SUPPORT_EVIDENCE_BUCKET_OPTIONS).toEqual({
      fileSizeLimit: 20 * 1024 * 1024,
      allowedMimeTypes: [...SUPPORT_ATTACHMENT_MIME_TYPES],
    });
    for (const mimeType of SUPPORT_ATTACHMENT_MIME_TYPES)
      expect(SUPPORT_ATTACHMENT_ACCEPT).toContain(mimeType);
  });
});

describe("PUT completes an upload only when its bytes match", () => {
  const db = prisma as unknown as {
    supportCase: {
      findFirst: jest.Mock;
      findUnique: jest.Mock;
      updateMany: jest.Mock;
    };
    supportCaseAttachment: { findFirst: jest.Mock; updateMany: jest.Mock };
  };
  const pending = {
    id: "file-1",
    caseId: "case-1",
    uploadedById: "uploader",
    mimeType: "application/pdf",
    fileSize: 9,
    storagePath: "support-cases/case-1/file-1",
    evidenceRequestId: null,
    completedAt: null,
  };
  const request = () =>
    new NextRequest("https://test/api/support/cases/case-1/attachments", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ attachmentId: "file-1" }),
    });

  beforeEach(() => {
    jest.clearAllMocks();
    db.supportCaseAttachment.findFirst.mockResolvedValue(pending);
    db.supportCase.findFirst.mockResolvedValue({
      id: "case-1",
      ownershipScope: "PERSONAL",
      organizationId: null,
      submitterUserId: "uploader",
      requesterUserId: "uploader",
      externalRequesterEmail: null,
    });
    storage.info.mockResolvedValue({
      data: { size: 9, contentType: "application/pdf" },
      error: null,
    });
    storage.createSignedUrl.mockResolvedValue({
      data: { signedUrl: "https://storage.test/object" },
      error: null,
    });
  });

  it("removes the object and tombstones the row when a PDF is really HTML", async () => {
    global.fetch = jest.fn(
      async () => new Response("<html><script>", { status: 206 }),
    ) as typeof fetch;

    const response = await PUT(request(), {
      params: Promise.resolve({ caseId: "case-1" }),
    });

    expect(response.status).toBe(400);
    expect(removeObjects).toHaveBeenCalledWith("support-attachments", [
      "support-cases/case-1/file-1",
    ]);
    expect(db.supportCaseAttachment.updateMany).toHaveBeenCalledWith({
      where: {
        id: "file-1",
        storagePath: "support-cases/case-1/file-1",
        completedAt: null,
        deletedAt: null,
      },
      data: { deletedAt: expect.any(Date) },
    });
  });

  it("asks only for the head of the object", async () => {
    const fetchMock = jest.fn(
      async () => new Response("<html>", { status: 206 }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    await PUT(request(), { params: Promise.resolve({ caseId: "case-1" }) });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://storage.test/object",
      expect.objectContaining({ headers: { Range: "bytes=0-511" } }),
    );
  });

  it("also discards an upload whose stored type disagrees with the declared one", async () => {
    storage.info.mockResolvedValue({
      data: { size: 9, contentType: "text/html" },
      error: null,
    });

    const response = await PUT(request(), {
      params: Promise.resolve({ caseId: "case-1" }),
    });

    expect(response.status).toBe(400);
    expect(removeObjects).toHaveBeenCalled();
  });

  it("keeps the upload for a retry when storage cannot be reached", async () => {
    global.fetch = jest.fn(async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;

    const response = await PUT(request(), {
      params: Promise.resolve({ caseId: "case-1" }),
    });

    expect(response.status).toBe(503);
    expect(removeObjects).not.toHaveBeenCalled();
  });

  it("keeps the upload for a retry when the head cannot be read", async () => {
    global.fetch = jest.fn(
      async () => new Response("", { status: 503 }),
    ) as typeof fetch;

    const response = await PUT(request(), {
      params: Promise.resolve({ caseId: "case-1" }),
    });

    expect(response.status).toBe(503);
    expect(removeObjects).not.toHaveBeenCalled();
  });
});
