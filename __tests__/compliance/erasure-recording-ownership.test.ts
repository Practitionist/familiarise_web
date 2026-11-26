/** @jest-environment node */

import type { ErasureStatus, Prisma, RecordingStatus } from "@prisma/client";

const mockFindMany = jest.fn();
const mockUpdateMany = jest.fn();
const mockUpdateManyAndReturn = jest.fn();
const mockUpdate = jest.fn();
const mockFindUnique = jest.fn();
const mockRemoveObjects = jest.fn();
const mockListPreviews = jest.fn();
const mockErasureRequestUpdate = jest.fn();
const mockDeleteStreamCopy = jest.fn();
let mockRequestStatus: ErasureStatus;

// Digital product erasure has its own suite; these scrubs own no products.
jest.mock("../../lib/digital-products/erasure", () => ({
  scrubDigitalProductsTx: jest.fn(async () => []),
  purgeErasedCreatorFiles: jest.fn(async () => []),
}));
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    user: {
      findUnique: async () => ({
        id: "erased-user",
        erasedAt: new Date("2026-10-01"),
        pseudonymousId: "existing-pseudonym",
      }),
    },
    organization: { findMany: async () => [] },
    membership: { findMany: async () => [] },
    consultantPayout: { count: async () => 0 },
    consultantEarnings: { count: async () => 0 },
    dispute: { count: async () => 0 },
    // The erased user hosts and holds no live booking.
    consultantProfile: { findFirst: async () => null },
    consultation: { count: async () => 0 },
    subscription: { count: async () => 0 },
    trial: { count: async () => 0 },
    appointment: { count: async () => 0 },
    erasureRequest: {
      findFirst: async () => null,
      findUnique: async () => ({
        id: "erasure-request",
        userId: "erased-user",
        status: mockRequestStatus,
      }),
      update: (...args: unknown[]) => mockErasureRequestUpdate(...args),
    },
    recording: {
      findMany: (...args: unknown[]) => mockFindMany(...args),
      updateMany: (...args: unknown[]) => mockUpdateMany(...args),
      updateManyAndReturn: (...args: unknown[]) =>
        mockUpdateManyAndReturn(...args),
      update: (...args: unknown[]) => mockUpdate(...args),
      findUnique: (...args: unknown[]) => mockFindUnique(...args),
    },
    recordingConsent: { updateMany: async () => ({ count: 0 }) },
  },
}));
jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));
jest.mock("../../lib/auth-helpers", () => ({
  requireBackofficeSurface: async () => ({
    session: { user: { id: "admin" } },
  }),
}));
jest.mock("../../lib/novu/client", () => ({ isNovuConfigured: () => true }));
jest.mock("../../lib/novu/subscriber", () => ({
  deleteSubscriber: async () => true,
}));
jest.mock("../../lib/documents/document-erasure", () => ({
  eraseUserSessionDocuments: async () => [],
}));
jest.mock("../../lib/support/erasure", () => ({
  supportAttachmentPaths: async () => [],
  removeSupportAttachmentObjects: async () => [],
}));
jest.mock("../../lib/stream-logger", () => ({
  streamLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock("../../lib/observability/report", () => ({
  reportSentryError: jest.fn(),
  reportSentryMessage: jest.fn(),
}));
jest.mock("../../lib/cron/with-cron-lock", () => ({
  withCronLock: (_job: string, _opts: unknown, run: () => unknown) => run(),
  readJobCheckpoint: () => Promise.resolve(null),
}));
jest.mock("../../lib/storage/r2-client", () => ({
  deleteR2Object: jest.fn(),
  streamMultipartToR2: jest.fn(),
  headR2Object: jest.fn(),
  isR2Configured: () => false,
}));
jest.mock("../../lib/stream/recording-stream-delete", () => ({
  deleteStreamRecordingCopy: (...args: unknown[]) =>
    mockDeleteStreamCopy(...args),
}));
jest.mock("../../lib/supabase-storage-core", () => ({
  removeObjects: (...args: unknown[]) => mockRemoveObjects(...args),
  adminStorage: () => ({
    from: () => ({ list: (...args: unknown[]) => mockListPreviews(...args) }),
  }),
}));

import prisma from "../../lib/prisma";
import { NextRequest } from "next/server";
import { POST } from "../../app/api/admin/erasure-requests/[id]/process/route";
import { scrubUser } from "../../lib/compliance/erasure/scrub-user";
import { expireRecordings } from "../../lib/stream/recording-retention";
import { transferRecording } from "../../lib/stream/recording-transfer-service";
import {
  deleteR2Object,
  headR2Object,
  streamMultipartToR2,
} from "../../lib/storage/r2-client";

type Row = {
  id: string;
  status: RecordingStatus;
  storagePath: string | null;
  previewClipStoragePath: string | null;
  recordingUrl: string;
  streamCallId: string | null;
  streamRecordingId: string | null;
  transferAttempts: number;
  updatedAt: Date;
  purchased: boolean;
};

let row: Row;
let objects: Set<string>;
let afterSelection: () => Promise<void>;

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function applyData(data: Prisma.RecordingUpdateManyMutationInput) {
  if (typeof data.status === "string") row.status = data.status;
  if (typeof data.recordingUrl === "string")
    row.recordingUrl = data.recordingUrl;
  if (typeof data.storagePath === "string" || data.storagePath === null)
    row.storagePath = data.storagePath;
  if (
    typeof data.previewClipStoragePath === "string" ||
    data.previewClipStoragePath === null
  )
    row.previewClipStoragePath = data.previewClipStoragePath;
  if (
    typeof data.streamRecordingId === "string" ||
    data.streamRecordingId === null
  )
    row.streamRecordingId = data.streamRecordingId;
  if (typeof data.transferAttempts === "number") {
    row.transferAttempts = data.transferAttempts;
  } else if (data.transferAttempts) {
    if (typeof data.transferAttempts.set === "number")
      row.transferAttempts = data.transferAttempts.set;
    if (typeof data.transferAttempts.increment === "number")
      row.transferAttempts += data.transferAttempts.increment;
  }
  const updatedAt = data.updatedAt;
  if (updatedAt instanceof Date) row.updatedAt = updatedAt;
  else if (typeof updatedAt === "string") row.updatedAt = new Date(updatedAt);
  else if (updatedAt?.set instanceof Date) row.updatedAt = updatedAt.set;
  else if (typeof updatedAt?.set === "string")
    row.updatedAt = new Date(updatedAt.set);
  else
    row.updatedAt = new Date(Math.max(Date.now(), row.updatedAt.getTime() + 1));
}

function matches(where: Prisma.RecordingWhereInput = {}) {
  if (Array.isArray(where.OR) && !where.OR.some(matches)) return false;
  if (typeof where.id === "string" && where.id !== row.id) return false;
  if (
    typeof where.transferAttempts === "number" &&
    where.transferAttempts !== row.transferAttempts
  )
    return false;
  if (
    where.updatedAt instanceof Date &&
    where.updatedAt.getTime() !== row.updatedAt.getTime()
  )
    return false;
  if (typeof where.status === "string" && where.status !== row.status)
    return false;
  if (
    typeof where.status === "object" &&
    Array.isArray(where.status.in) &&
    !where.status.in.includes(row.status)
  )
    return false;
  if (
    typeof where.status === "object" &&
    Array.isArray(where.status.notIn) &&
    where.status.notIn.includes(row.status)
  )
    return false;
  if (
    typeof where.status === "object" &&
    typeof where.status.not === "string" &&
    where.status.not === row.status
  )
    return false;
  if (where.purchases && row.purchased) return false;
  if (
    typeof where.storagePath === "object" &&
    where.storagePath?.not === null &&
    row.storagePath === null
  )
    return false;
  if (
    typeof where.previewClipStoragePath === "object" &&
    where.previewClipStoragePath?.not === null &&
    row.previewClipStoragePath === null
  )
    return false;
  if (
    (typeof where.storagePath === "string" || where.storagePath === null) &&
    where.storagePath !== row.storagePath
  )
    return false;
  if (
    (typeof where.previewClipStoragePath === "string" ||
      where.previewClipStoragePath === null) &&
    where.previewClipStoragePath !== row.previewClipStoragePath
  )
    return false;
  if (
    typeof where.streamRecordingId === "object" &&
    where.streamRecordingId?.not === null &&
    row.streamRecordingId === null
  )
    return false;
  if (
    (typeof where.streamRecordingId === "string" ||
      where.streamRecordingId === null) &&
    where.streamRecordingId !== row.streamRecordingId
  )
    return false;
  return true;
}

beforeEach(() => {
  jest.clearAllMocks();
  row = {
    id: "recording-one",
    status: "READY",
    storagePath: null,
    previewClipStoragePath: null,
    recordingUrl: "https://video.cloudfront.net/immutable-source.mp4",
    streamCallId: null,
    streamRecordingId: "immutable-source.mp4",
    transferAttempts: 0,
    updatedAt: new Date("2026-10-01T00:00:00.000Z"),
    purchased: false,
  };
  objects = new Set();
  afterSelection = async () => {};
  mockRequestStatus = "PENDING";
  mockErasureRequestUpdate.mockImplementation(
    async ({ data }: Prisma.ErasureRequestUpdateArgs) => {
      if (typeof data.status === "string") mockRequestStatus = data.status;
      return {};
    },
  );
  mockFindMany.mockImplementation(
    async ({ where }: Prisma.RecordingFindManyArgs) => {
      if (where?.purchases) {
        const selected = matches(where) ? [{ ...row }] : [];
        await afterSelection();
        return selected;
      }
      return where?.status === "EXPIRED" && matches(where) && row.storagePath
        ? [{ ...row }]
        : [];
    },
  );
  mockUpdateManyAndReturn.mockImplementation(
    async ({ where, data }: Prisma.RecordingUpdateManyAndReturnArgs) => {
      if (!matches(where)) return [];
      applyData(data);
      return [{ ...row }];
    },
  );
  mockUpdateMany.mockImplementation(
    async ({ where, data }: Prisma.RecordingUpdateManyArgs) => {
      if (!matches(where)) return { count: 0 };
      applyData(data);
      return { count: 1 };
    },
  );
  mockUpdate.mockImplementation(
    async ({ data }: Prisma.RecordingUpdateArgs) => {
      applyData(data);
      return { ...row };
    },
  );
  mockFindUnique.mockImplementation(async () => ({ ...row }));
  jest.mocked(deleteR2Object).mockImplementation(async ({ key }) => {
    objects.delete(key);
    return { success: true };
  });
  jest.mocked(streamMultipartToR2).mockImplementation(async ({ key }) => {
    objects.add(key);
    return { key, size: 4, parts: 1 };
  });
  jest.mocked(headR2Object).mockResolvedValue({ contentLength: 4 });
  mockRemoveObjects.mockResolvedValue(true);
  mockDeleteStreamCopy.mockResolvedValue({ success: true });
  mockListPreviews.mockResolvedValue({ data: [], error: null });
  jest.spyOn(global, "fetch").mockResolvedValue(
    new Response("copy", {
      headers: { "content-length": "4", "content-type": "video/mp4" },
    }),
  );
});

afterEach(() => jest.restoreAllMocks());

async function pauseCopyAtHead() {
  const arrived = deferred();
  const resume = deferred();
  jest.mocked(headR2Object).mockImplementationOnce(async () => {
    arrived.resolve();
    await resume.promise;
    return { contentLength: 4 };
  });
  const copy = transferRecording(row.id);
  await arrived.promise;
  return { copy, resume };
}

it("deletes the published attempt when transfer wins after erasure selection", async () => {
  const { copy, resume } = await pauseCopyAtHead();
  const selected = deferred();
  const resumeSelection = deferred();
  afterSelection = async () => {
    selected.resolve();
    await resumeSelection.promise;
  };
  const erasure = scrubUser(prisma, "erased-user");
  try {
    await selected.promise;
    resume.resolve();
    expect(await copy).toEqual({ status: "copied" });
    const publishedPath = row.storagePath;
    expect(publishedPath).toBe("recordings/recording-one/attempt-1.mp4");
    resumeSelection.resolve();
    expect((await erasure).vendorFailures).toEqual([]);
    expect(deleteR2Object).toHaveBeenCalledWith({ key: publishedPath });
    expect(objects.size).toBe(0);
    expect(row).toMatchObject({ status: "EXPIRED", storagePath: null });
  } finally {
    resume.resolve();
    resumeSelection.resolve();
    await Promise.allSettled([copy, erasure]);
  }
});

it("prevents publication when erasure expires a copy still waiting at HEAD", async () => {
  const { copy, resume } = await pauseCopyAtHead();
  try {
    expect((await scrubUser(prisma, "erased-user")).vendorFailures).toEqual([]);
    expect(row.status).toBe("EXPIRED");
    resume.resolve();
    expect(await copy).toEqual({ status: "skipped" });
    expect(objects.size).toBe(0);
    expect(row.storagePath).toBeNull();
    expect(row.streamRecordingId).toBeNull();
  } finally {
    resume.resolve();
    await Promise.allSettled([copy]);
  }
});

it("leaves failed erasure pointers for the real expiry entry to retry", async () => {
  row.status = "AVAILABLE";
  row.storagePath = "recordings/recording-one/attempt-1.mp4";
  objects.add(row.storagePath);
  jest.mocked(deleteR2Object).mockResolvedValueOnce({
    success: false,
    error: "temporary storage outage",
  });
  const first = await scrubUser(prisma, "erased-user");
  expect(first.vendorFailures).toEqual([
    expect.stringContaining("recording_storage:recording-one"),
  ]);
  expect(row).toMatchObject({
    status: "EXPIRED",
    storagePath: "recordings/recording-one/attempt-1.mp4",
  });
  const retry = await expireRecordings({ limit: 1 });
  expect(retry).toMatchObject({ success: true, cleaned: 1, expired: 0 });
  expect(deleteR2Object).toHaveBeenCalledTimes(2);
  expect(objects.size).toBe(0);
  expect(row.storagePath).toBeNull();
  expect(row.streamRecordingId).toBeNull();
});

it("keeps the admin request open until a failed expired asset is deleted on retry", async () => {
  row.status = "AVAILABLE";
  row.storagePath = "recordings/recording-one/attempt-1.mp4";
  objects.add(row.storagePath);
  jest.mocked(deleteR2Object).mockResolvedValue({
    success: false,
    error: "temporary storage outage",
  });
  const process = () =>
    POST(
      new NextRequest(
        "http://localhost/api/admin/erasure-requests/request/process",
        {
          method: "POST",
        },
      ),
      { params: Promise.resolve({ id: "erasure-request" }) },
    );

  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await process();
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      status: "IN_PROGRESS",
      vendorFailures: [
        expect.stringContaining("recording_storage:recording-one"),
      ],
    });
    expect(mockRequestStatus).toBe("IN_PROGRESS");
    expect(row).toMatchObject({
      status: "EXPIRED",
      storagePath: "recordings/recording-one/attempt-1.mp4",
    });
  }
  jest.mocked(deleteR2Object).mockImplementation(async ({ key }) => {
    objects.delete(key);
    return { success: true };
  });
  expect((await process()).status).toBe(200);
  expect(mockRequestStatus).toBe("COMPLETED");
  expect(row.storagePath).toBeNull();
  expect(objects.size).toBe(0);
  expect(deleteR2Object).toHaveBeenCalledTimes(3);
  expect(mockUpdateManyAndReturn).toHaveBeenLastCalledWith(
    // The row was already EXPIRED, so the retry claim re-captures it without restamping removal.
    expect.objectContaining({ data: { recordingUrl: "" } }),
  );
});

it("retains both claimed pointers when preview deletion fails", async () => {
  row.status = "AVAILABLE";
  row.storagePath = "recordings/recording-one/attempt-1.mp4";
  row.previewClipStoragePath = "recording-one/preview.mp4";
  objects.add(row.storagePath);
  mockListPreviews.mockResolvedValueOnce({
    data: [{ name: "preview.mp4" }],
    error: null,
  });
  mockRemoveObjects.mockResolvedValueOnce(false);

  expect((await scrubUser(prisma, "erased-user")).vendorFailures).toHaveLength(
    1,
  );
  expect(row).toMatchObject({
    status: "EXPIRED",
    storagePath: "recordings/recording-one/attempt-1.mp4",
    previewClipStoragePath: "recording-one/preview.mp4",
  });
  expect(objects.size).toBe(0);
  expect(mockRemoveObjects).toHaveBeenCalledWith("recordings-previews", [
    "recording-one/preview.mp4",
  ]);
});

it("accepts expiry clearing the same pointers while erasure waits for deletion", async () => {
  row.status = "AVAILABLE";
  row.storagePath = "recordings/recording-one/attempt-1.mp4";
  objects.add(row.storagePath);
  const deleting = deferred();
  const resumeDelete = deferred();
  jest.mocked(deleteR2Object).mockImplementationOnce(async ({ key }) => {
    deleting.resolve();
    await resumeDelete.promise;
    objects.delete(key);
    return { success: true };
  });

  const erasure = scrubUser(prisma, "erased-user");
  try {
    await deleting.promise;
    expect(await expireRecordings({ limit: 1 })).toMatchObject({
      success: true,
      cleaned: 1,
    });
    resumeDelete.resolve();
    expect((await erasure).vendorFailures).toEqual([]);
    expect(row).toMatchObject({ status: "EXPIRED", storagePath: null });
    expect(objects.size).toBe(0);
  } finally {
    resumeDelete.resolve();
    await Promise.allSettled([erasure]);
  }
});

it("does not clear a pointer that changes while vendor deletion is pending", async () => {
  row.status = "AVAILABLE";
  row.storagePath = "old.mp4";
  jest.mocked(deleteR2Object).mockImplementationOnce(async () => {
    row.storagePath = "replacement.mp4";
    return { success: true };
  });

  expect((await scrubUser(prisma, "erased-user")).vendorFailures).toHaveLength(
    1,
  );
  expect(row.storagePath).toBe("replacement.mp4");
});

it("rechecks purchase protection in the claim after selection", async () => {
  row.status = "AVAILABLE";
  row.storagePath = "protected.mp4";
  afterSelection = async () => {
    row.purchased = true;
  };

  expect((await scrubUser(prisma, "erased-user")).vendorFailures).toEqual([]);
  expect(deleteR2Object).not.toHaveBeenCalled();
  expect(row).toMatchObject({
    status: "AVAILABLE",
    storagePath: "protected.mp4",
  });
  expect(mockUpdateManyAndReturn).toHaveBeenCalledWith(
    expect.objectContaining({
      where: expect.objectContaining({
        purchases: { none: {} },
        meeting: {
          occurrence: {
            appointment: expect.objectContaining({
              appointmentType: {
                in: ["CONSULTATION", "SUBSCRIPTION", "TRIAL"],
              },
            }),
          },
        },
      }),
    }),
  );
});

it("re-drives a Stream copy left on an expired row with no storage pointers", async () => {
  row.status = "EXPIRED";
  row.recordingUrl = "";
  row.streamCallId = "call-one";

  expect((await scrubUser(prisma, "erased-user")).vendorFailures).toEqual([]);
  expect(mockDeleteStreamCopy).toHaveBeenCalledWith(
    expect.objectContaining({
      streamCallId: "call-one",
      streamRecordingId: "immutable-source.mp4",
    }),
  );
  expect(row).toMatchObject({ status: "EXPIRED", streamRecordingId: null });
});

it("claims the row before a failed Stream delete and keeps its pointers", async () => {
  row.status = "AVAILABLE";
  row.storagePath = "recordings/recording-one/attempt-1.mp4";
  row.streamCallId = "call-one";
  mockDeleteStreamCopy.mockResolvedValueOnce({ success: false });

  expect((await scrubUser(prisma, "erased-user")).vendorFailures).toEqual([
    expect.stringContaining("recording_storage:recording-one"),
  ]);
  expect(mockUpdateManyAndReturn.mock.invocationCallOrder[0]).toBeLessThan(
    mockDeleteStreamCopy.mock.invocationCallOrder[0],
  );
  expect(row).toMatchObject({
    status: "EXPIRED",
    storagePath: "recordings/recording-one/attempt-1.mp4",
    streamRecordingId: "immutable-source.mp4",
  });
});
