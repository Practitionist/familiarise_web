/** @jest-environment node */

import type { SupportCaseAttachment } from "@prisma/client";

const DAY = 86_400_000;
const PATH = "support-cases/case-1/file-1";
let attachment: SupportCaseAttachment | null;
let objectPresent: boolean;
let deleteFailure: "error" | "throw" | null;
let listedPaths: string[];
let listedCreatedAt: string;
const originalFetch = global.fetch;
const originalUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const originalKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const db = {
  supportCase: {
    findFirst: jest.fn(),
    findUnique: jest.fn(),
    updateMany: jest.fn(),
  },
  supportCaseAttachment: {
    findFirst: jest.fn(),
    findMany: jest.fn(),
    updateMany: jest.fn(),
  },
  supportCaseEvidenceRequest: {
    findFirst: jest.fn(),
    findUnique: jest.fn(),
  },
  appointmentDocument: {
    findMany: jest.fn(async () => []),
    updateMany: jest.fn(),
  },
  planMaterial: { findMany: jest.fn(async () => []) },
  profileVerificationDocument: { findMany: jest.fn(async () => []) },
  $transaction: jest.fn(),
};
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  get default() {
    return db;
  },
}));
jest.mock("../../lib/cron/with-cron-lock", () => ({
  withCronLock: (_name: string, _options: unknown, run: () => unknown) => run(),
  LONG_JOB_TTL_MS: 1,
}));
jest.mock("../../lib/auth-helpers", () => ({
  requireApiAuth: async () => ({
    session: { user: { id: "uploader", role: "CONSULTEE" } },
  }),
}));
jest.mock("../../lib/rate-limit", () => ({
  documentUploadLimiter: {},
  applyRateLimit: async () => null,
}));
jest.mock("../../lib/support/case-access", () => ({
  canCorrespondOnCase: async () => true,
}));
jest.mock("../../lib/support/case-actions", () => ({
  CaseActionError: class extends Error {},
  evidenceRecipients: async () => [{ id: "uploader" }],
}));

const remove = jest.fn(async (_bucket: string, paths: string[]) => {
  if (deleteFailure === "throw") throw new Error("storage unreachable");
  if (deleteFailure === "error")
    return { data: null, error: new Error("storage refused deletion") };
  objectPresent = false;
  return { data: paths.map((name) => ({ name })), error: null };
});
const bucket = (name: string) => ({
  list: async () => ({
    data:
      name === "support-attachments" && objectPresent
        ? listedPaths.map((path) => ({
            name: path,
            metadata: {},
            created_at: listedCreatedAt,
          }))
        : [],
    error: null,
  }),
  remove: (paths: string[]) => remove(name, paths),
  info: async () => ({
    data: objectPresent ? { size: 9, contentType: "application/pdf" } : null,
    error: null,
  }),
  createSignedUrl: async () => ({
    data: { signedUrl: "https://storage.test/object" },
    error: null,
  }),
});
jest.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ storage: { from: (name: string) => bucket(name) } }),
}));
const removeObjects = jest.fn(
  async (_bucket: string, _paths: string[]) => true,
);
jest.mock("../../lib/supabase-storage-core", () => ({
  adminStorage: () => ({ from: (name: string) => bucket(name) }),
  ensureBucketExists: async () => true,
  removeObjects: (...args: [string, string[]]) => removeObjects(...args),
}));

import { NextRequest } from "next/server";
import { PUT } from "../../app/api/support/cases/[caseId]/attachments/route";
import { discardPendingAttachment } from "../../lib/support/case-attachments";
import { reconcileDocumentStorage } from "../../scripts/cleanup/reconcile-document-storage";

type StringMatch = string | { in: string[] };
type Where = {
  id?: StringMatch;
  storagePath?: StringMatch;
  caseId?: string;
  uploadedById?: string;
  completedAt?: null | { not: null };
  deletedAt?: null;
  createdAt?: { lt?: Date; gte?: Date };
  OR?: Where[];
};

function matchesString(value: string, filter?: StringMatch): boolean {
  if (filter === undefined) return true;
  return typeof filter === "string"
    ? value === filter
    : filter.in.includes(value);
}

function matches(where: Where): boolean {
  if (!attachment) return false;
  if (!matchesString(attachment.id, where.id)) return false;
  if (!matchesString(attachment.storagePath, where.storagePath)) return false;
  if (where.caseId && where.caseId !== attachment.caseId) return false;
  if (where.uploadedById && where.uploadedById !== attachment.uploadedById)
    return false;
  if (where.completedAt === null && attachment.completedAt !== null)
    return false;
  if (where.completedAt?.not === null && attachment.completedAt === null)
    return false;
  if (where.deletedAt === null && attachment.deletedAt !== null) return false;
  if (where.createdAt?.lt && attachment.createdAt >= where.createdAt.lt)
    return false;
  if (where.createdAt?.gte && attachment.createdAt < where.createdAt.gte)
    return false;
  return !where.OR || where.OR.some(matches);
}

function gate() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function complete() {
  return PUT(
    new NextRequest("https://test/api/support/cases/case-1/attachments", {
      method: "PUT",
      body: JSON.stringify({ attachmentId: "file-1" }),
    }),
    { params: Promise.resolve({ caseId: "case-1" }) },
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  attachment = {
    id: "file-1",
    caseId: "case-1",
    uploadedById: "uploader",
    originalName: "file.pdf",
    mimeType: "application/pdf",
    fileSize: 9,
    storagePath: PATH,
    messageId: null,
    evidenceRequestId: null,
    completedAt: null,
    deletedAt: null,
    createdAt: new Date(Date.now() - 8 * DAY),
  };
  objectPresent = true;
  deleteFailure = null;
  listedPaths = [PATH];
  listedCreatedAt = "2020-01-01T00:00:00Z";
  db.supportCase.findFirst.mockResolvedValue({ id: "case-1" });
  db.supportCase.findUnique.mockResolvedValue({
    updatedAt: new Date(),
    closedAt: null,
  });
  db.supportCase.updateMany.mockResolvedValue({ count: 1 });
  db.supportCaseEvidenceRequest.findFirst.mockResolvedValue({
    recipientUserId: "uploader",
  });
  db.supportCaseEvidenceRequest.findUnique.mockResolvedValue({
    respondedAt: null,
    cancelledAt: null,
  });
  db.supportCaseAttachment.findFirst.mockImplementation(
    async ({ where }: { where: Where }) =>
      matches(where) && attachment ? { ...attachment } : null,
  );
  db.supportCaseAttachment.findMany.mockImplementation(
    async ({ where }: { where: Where }) =>
      matches(where) && attachment ? [{ ...attachment }] : [],
  );
  db.supportCaseAttachment.updateMany.mockImplementation(
    async ({
      where,
      data,
    }: {
      where: Where;
      data: Partial<SupportCaseAttachment>;
    }) => {
      if (!matches(where) || !attachment) return { count: 0 };
      attachment = { ...attachment, ...data };
      return { count: 1 };
    },
  );
  db.$transaction.mockImplementation(
    async (run: (tx: typeof db) => Promise<unknown>) => run(db),
  );
  removeObjects.mockResolvedValue(true);
  global.fetch = jest.fn(async () => new Response("%PDF-1.7\n"));
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://storage.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "mock-service-key";
  jest.spyOn(console, "log").mockImplementation(() => undefined);
  jest.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
  global.fetch = originalFetch;
  if (originalUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  else process.env.NEXT_PUBLIC_SUPABASE_URL = originalUrl;
  if (originalKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  else process.env.SUPABASE_SERVICE_ROLE_KEY = originalKey;
});

it("keeps an attachment finalised after the orphan snapshot", async () => {
  const discovered = gate();
  const resume = gate();
  db.supportCaseAttachment.findMany.mockImplementationOnce(async () => {
    discovered.release();
    await resume.promise;
    return [];
  });
  const cleanup = reconcileDocumentStorage();
  await discovered.promise;
  expect((await complete()).status).toBe(200);
  resume.release();
  await cleanup;
  expect(remove).not.toHaveBeenCalled();
  expect(objectPresent).toBe(true);
  expect(attachment?.completedAt).toBeInstanceOf(Date);
});

it("returns 409 when cleanup wins after finalisation verifies the object", async () => {
  const verified = gate();
  const resume = gate();
  global.fetch = jest.fn(async () => {
    verified.release();
    await resume.promise;
    return new Response("%PDF-1.7\n");
  });
  const finalising = complete();
  await verified.promise;
  await reconcileDocumentStorage();
  resume.release();
  expect((await finalising).status).toBe(409);
  expect(attachment?.deletedAt).toBeInstanceOf(Date);
  expect(attachment?.completedAt).toBeNull();
  expect(objectPresent).toBe(false);
});

it("returns 200 when another finaliser wins the same pending-row CAS", async () => {
  const verified = gate();
  const resume = gate();
  jest.mocked(global.fetch).mockImplementationOnce(async () => {
    verified.release();
    await resume.promise;
    return new Response("%PDF-1.7\n");
  });
  const first = complete();
  await verified.promise;
  expect((await complete()).status).toBe(200);
  resume.release();
  const response = await first;
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    data: { id: "file-1", completed: true },
  });
});

it("keeps a concurrent completion when the parent-case CAS loses first", async () => {
  db.supportCase.updateMany.mockImplementationOnce(async () => {
    if (!attachment) throw new Error("missing fixture");
    attachment.completedAt = new Date();
    return { count: 0 };
  });
  const response = await complete();
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    data: { id: "file-1", completed: true },
  });
});

it("returns 409 for a parent-case conflict without a completed attachment", async () => {
  db.supportCase.updateMany.mockResolvedValueOnce({ count: 0 });
  expect((await complete()).status).toBe(409);
  expect(attachment?.completedAt).toBeNull();
});

it("returns 409 when the pending upload's case closes before its transaction", async () => {
  db.supportCase.findUnique.mockResolvedValue({ closedAt: new Date() });
  expect((await complete()).status).toBe(409);
  expect(attachment?.completedAt).toBeNull();
});

it("returns 409 when the evidence response closes between preflight and transaction", async () => {
  if (!attachment) throw new Error("missing fixture");
  attachment.evidenceRequestId = "request-1";
  db.supportCaseEvidenceRequest.findUnique
    .mockResolvedValueOnce({ respondedAt: null, cancelledAt: null })
    .mockResolvedValueOnce({ respondedAt: new Date(), cancelledAt: null });
  expect((await complete()).status).toBe(409);
  expect(attachment.completedAt).toBeNull();
});

it("preserves the existing completed replay policy after case/evidence closure", async () => {
  if (!attachment) throw new Error("missing fixture");
  attachment.evidenceRequestId = "request-1";
  attachment.completedAt = new Date();
  db.supportCase.findFirst.mockResolvedValue({
    id: "case-1",
    closedAt: new Date(),
  });
  db.supportCaseEvidenceRequest.findFirst.mockResolvedValue({
    recipientUserId: "uploader",
    respondedAt: new Date(),
  });
  expect((await complete()).status).toBe(200);
  expect(db.$transaction).not.toHaveBeenCalled();
});

it("does not mask a closure with a replay of tombstoned completed evidence", async () => {
  db.supportCase.findUnique.mockResolvedValue({ closedAt: new Date() });
  db.supportCaseAttachment.findFirst.mockImplementationOnce(async () => {
    if (!attachment) throw new Error("missing fixture");
    const prior = { ...attachment };
    attachment.completedAt = new Date();
    attachment.deletedAt = new Date();
    return prior;
  });
  expect((await complete()).status).toBe(409);
});

it("rechecks completion in the claim CAS after selecting a pending row", async () => {
  const apply = db.supportCaseAttachment.updateMany.getMockImplementation();
  if (!apply) throw new Error("missing fixture mutation");
  db.supportCaseAttachment.updateMany.mockImplementationOnce(async (args) => {
    if (!attachment) throw new Error("missing fixture");
    attachment.completedAt = new Date();
    return apply(args);
  });
  await reconcileDocumentStorage();
  expect(attachment?.deletedAt).toBeNull();
  expect(remove).not.toHaveBeenCalled();
  expect(objectPresent).toBe(true);
});

it.each(["error", "throw"] as const)(
  "retains the cleanup claim after storage %s and retries it next run",
  async (failure) => {
    deleteFailure = failure;
    expect((await reconcileDocumentStorage()).success).toBe(false);
    expect(attachment?.deletedAt).toBeInstanceOf(Date);
    expect((await complete()).status).toBe(404);
    expect(objectPresent).toBe(true);
    deleteFailure = null;
    expect((await reconcileDocumentStorage()).orphanedFilesDeleted).toBe(1);
    expect(objectPresent).toBe(false);
  },
);

it("keeps a recent pending row even when a stale listing exposes its path", async () => {
  if (!attachment) throw new Error("missing fixture");
  attachment.createdAt = new Date();
  db.supportCaseAttachment.findMany.mockResolvedValueOnce([]);
  await reconcileDocumentStorage();
  expect(remove).not.toHaveBeenCalled();
  expect(attachment.deletedAt).toBeNull();
});

it("keeps the seven-day object grace before claiming an old pending row", async () => {
  listedCreatedAt = new Date().toISOString();
  await reconcileDocumentStorage();
  expect(db.supportCaseAttachment.updateMany).not.toHaveBeenCalled();
  expect(remove).not.toHaveBeenCalled();
  expect(attachment?.deletedAt).toBeNull();
});

it("does not remove bytes when the database claim fails", async () => {
  db.supportCaseAttachment.updateMany.mockRejectedValueOnce(
    new Error("database unavailable"),
  );
  expect((await reconcileDocumentStorage()).success).toBe(false);
  expect(remove).not.toHaveBeenCalled();
  expect(attachment?.deletedAt).toBeNull();
});

it("retries a committed claim when the invocation fails before storage removal", async () => {
  const findMany = db.supportCaseAttachment.findMany.getMockImplementation();
  if (!findMany) throw new Error("missing fixture query");
  let failAfterClaim = true;
  db.supportCaseAttachment.findMany.mockImplementation(async (args) => {
    if (attachment?.deletedAt && failAfterClaim) {
      failAfterClaim = false;
      throw new Error("interrupted after claim");
    }
    return findMany(args);
  });
  expect((await reconcileDocumentStorage()).success).toBe(false);
  expect(attachment?.deletedAt).toBeInstanceOf(Date);
  expect(remove).not.toHaveBeenCalled();
  expect((await complete()).status).toBe(404);
  expect((await reconcileDocumentStorage()).orphanedFilesDeleted).toBe(1);
  expect(objectPresent).toBe(false);
});

it("bounds support ownership queries and vendor removals to 100 paths", async () => {
  listedPaths = [PATH, ...Array.from({ length: 200 }, (_, i) => `orphan-${i}`)];
  expect((await reconcileDocumentStorage()).orphanedFilesDeleted).toBe(201);
  const querySizes = db.supportCaseAttachment.findMany.mock.calls.flatMap(
    ([args]) => {
      const where: Where = args.where;
      return where.storagePath && typeof where.storagePath !== "string"
        ? [where.storagePath.in.length]
        : [];
    },
  );
  expect(querySizes).toEqual([100, 100, 100, 100, 1, 1]);
  for (const [args] of db.supportCaseAttachment.updateMany.mock.calls) {
    expect(args.where).toEqual({
      storagePath: { in: listedPaths.slice(0, 100) },
      id: { in: ["file-1"] },
      completedAt: null,
      deletedAt: null,
      createdAt: { lt: expect.any(Date) },
    });
  }
  expect(remove.mock.calls.map(([, paths]) => paths.length)).toEqual([
    100, 100, 1,
  ]);
});

it("deletes a path with no attachment row", async () => {
  attachment = null;
  expect((await reconcileDocumentStorage()).orphanedFilesDeleted).toBe(1);
  expect(objectPresent).toBe(false);
});

it("keeps the normal upload and completion path", async () => {
  const response = await complete();
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    data: { id: "file-1", completed: true },
  });
  expect(attachment?.deletedAt).toBeNull();
  expect((await complete()).status).toBe(200);
});

it("never removes rejected-upload bytes after losing the pending-row claim", async () => {
  expect((await complete()).status).toBe(200);
  await discardPendingAttachment({ id: "file-1", storagePath: PATH });
  expect(removeObjects).not.toHaveBeenCalled();
  expect(attachment?.deletedAt).toBeNull();
});

it("commits the rejection tombstone before attempting vendor deletion", async () => {
  removeObjects.mockImplementationOnce(async () => {
    expect(attachment?.deletedAt).toBeInstanceOf(Date);
    return false;
  });
  await discardPendingAttachment({ id: "file-1", storagePath: PATH });
  expect(attachment?.deletedAt).toBeInstanceOf(Date);
  expect((await complete()).status).toBe(404);
});

it("waits for object grace before retrying failed removal of a fresh rejected upload", async () => {
  if (!attachment) throw new Error("missing fixture");
  attachment.createdAt = new Date();
  listedCreatedAt = new Date().toISOString();
  removeObjects.mockResolvedValueOnce(false);
  await discardPendingAttachment({ id: "file-1", storagePath: PATH });
  await reconcileDocumentStorage();
  expect(attachment.deletedAt).toBeInstanceOf(Date);
  expect(remove).not.toHaveBeenCalled();
  expect(objectPresent).toBe(true);
  listedCreatedAt = "2020-01-01T00:00:00Z";
  expect((await reconcileDocumentStorage()).orphanedFilesDeleted).toBe(1);
  expect(objectPresent).toBe(false);
});
