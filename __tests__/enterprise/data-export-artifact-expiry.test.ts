/** @jest-environment node */

const mockArtifactFindMany = jest.fn();
const mockArtifactUpdateMany = jest.fn();
const mockArtifactDeleteMany = jest.fn();
const mockJobFindFirst = jest.fn();
const mockJobUpdateMany = jest.fn();
const mockArtifactCreate = jest.fn();
const mockAuditCreate = jest.fn();
const mockMembershipFindUnique = jest.fn();
const mockExists = jest.fn();
const mockRemoveObjects = jest.fn();
const mockRecordSystemError = jest.fn();
const mockStageReadyEmail = jest.fn();
const mockAttemptStaged = jest.fn();
const mockStageReadyNotification = jest.fn();
const mockAttemptNotification = jest.fn();
const mockStorageUpload = jest.fn();

jest.mock("../../lib/prisma", () => {
  const db = {
    orgDataExportArtifact: {
      findMany: (...args: unknown[]) => mockArtifactFindMany(...args),
      updateMany: (...args: unknown[]) => mockArtifactUpdateMany(...args),
      deleteMany: (...args: unknown[]) => mockArtifactDeleteMany(...args),
      create: (...args: unknown[]) => mockArtifactCreate(...args),
    },
    orgDataExportJob: {
      findFirst: (...args: unknown[]) => mockJobFindFirst(...args),
      updateMany: (...args: unknown[]) => mockJobUpdateMany(...args),
    },
    membership: {
      findUnique: (...args: unknown[]) => mockMembershipFindUnique(...args),
      findMany: async () => [],
    },
    organization: { findUnique: async () => ({ name: "Example org" }) },
    contract: { findMany: async () => [] },
    program: { findMany: async () => [] },
    organizationInvoice: { findMany: async () => [] },
    organizationEarnings: { findMany: async () => [] },
    organizationPayout: { findMany: async () => [] },
    orgAuditLog: {
      create: (...args: unknown[]) => mockAuditCreate(...args),
      findMany: async () => [],
    },
    $transaction: async (
      fn: ((tx: unknown) => unknown) | Promise<unknown>[],
    ) => (typeof fn === "function" ? fn(db) : Promise.all(fn)),
  };
  return { __esModule: true, default: db };
});

jest.mock("../../lib/cron/with-cron-lock", () => ({
  LONG_JOB_TTL_MS: 35 * 60 * 1000,
  withCronLock: (_job: string, _opts: unknown, fn: () => unknown) => fn(),
}));

jest.mock("../../lib/supabase-storage-core", () => ({
  adminStorage: () => ({
    from: () => ({ exists: (...args: unknown[]) => mockExists(...args) }),
  }),
  removeObjects: (...args: unknown[]) => mockRemoveObjects(...args),
}));

jest.mock("../../lib/enterprise/system-events", () => ({
  recordSystemError: (...args: unknown[]) => mockRecordSystemError(...args),
}));

jest.mock("../../lib/compliance/dpdp", () => ({
  checkConsentBatch: async () => new Set<string>(),
}));

jest.mock("../../lib/email/senders/money", () => ({
  stageOrgOperationalEmail: (...args: unknown[]) =>
    mockStageReadyEmail(...args),
}));

jest.mock("../../lib/email/send-to-recipients", () => ({
  attemptStaged: (...args: unknown[]) => mockAttemptStaged(...args),
}));

jest.mock("../../lib/novu/org-workflows", () => ({
  notifyOrgDataExportReady: (...args: unknown[]) =>
    mockStageReadyNotification(...args),
}));

jest.mock("../../lib/novu/outbox", () => ({
  attemptTrigger: (...args: unknown[]) => mockAttemptNotification(...args),
}));

jest.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    storage: {
      from: () => ({
        upload: (...args: unknown[]) => mockStorageUpload(...args),
      }),
    },
  }),
}));

import { processDataExports } from "../../scripts/cleanup/process-data-exports";

const attemptStartedAt = new Date("2026-10-01T00:00:00.000Z");
const artifact = {
  exportJobId: "export-1",
  attemptStartedAt,
  bucket: "org-exports",
  storagePath: "org-1/export-1/1790812800000.json",
  expiresAt: new Date("2026-10-08T00:00:00.000Z"),
  createdAt: new Date("2026-10-01T00:00:00.000Z"),
  lastDeleteAttemptedAt: null,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockArtifactFindMany.mockResolvedValue([artifact]);
  mockArtifactUpdateMany.mockResolvedValue({ count: 1 });
  mockArtifactDeleteMany.mockResolvedValue({ count: 1 });
  mockJobFindFirst.mockResolvedValue(null);
  mockJobUpdateMany.mockResolvedValue({ count: 0 });
  mockArtifactCreate.mockResolvedValue({});
  mockAuditCreate.mockResolvedValue({});
  mockMembershipFindUnique.mockResolvedValue(null);
  mockStageReadyEmail.mockResolvedValue([]);
  mockAttemptStaged.mockResolvedValue(undefined);
  mockStageReadyNotification.mockResolvedValue([]);
  mockAttemptNotification.mockResolvedValue({ success: true });
  mockStorageUpload.mockResolvedValue({ error: null });
  mockRemoveObjects.mockResolvedValue(true);
  mockExists.mockResolvedValue({ data: false, error: null });
});

describe("export artifact expiry", () => {
  it("retains the owner when remove reports success but exact-path read-back is uncertain", async () => {
    mockExists.mockResolvedValue({
      data: false,
      error: { message: "permission denied" },
    });

    const result = await processDataExports();

    expect(mockRemoveObjects).toHaveBeenCalledWith(artifact.bucket, [
      artifact.storagePath,
    ]);
    expect(mockExists).toHaveBeenCalledWith(artifact.storagePath);
    expect(mockArtifactDeleteMany).not.toHaveBeenCalled();
    expect(mockJobUpdateMany).not.toHaveBeenCalled();
    expect(result).toMatchObject({ expiryFailed: 1, success: false });
  });

  it("retires the owner only after exact-path read-back confirms absence", async () => {
    await processDataExports();

    expect(mockArtifactDeleteMany).toHaveBeenCalledWith({
      where: {
        exportJobId: artifact.exportJobId,
        attemptStartedAt,
        lastDeleteAttemptedAt: expect.any(Date),
      },
    });
  });

  it("does not create an artifact or upload when the claim CAS loses", async () => {
    mockArtifactFindMany.mockResolvedValue([]);
    mockJobFindFirst.mockResolvedValue({
      id: "export-2",
      status: "PENDING",
      startedAt: null,
      organizationId: "org-1",
      requestedByMembershipId: "membership-1",
      kind: "PEOPLE",
    });
    mockJobUpdateMany.mockResolvedValue({ count: 0 });

    const result = await processDataExports();

    expect(result).toMatchObject({ picked: 0, superseded: 1 });
    expect(mockArtifactUpdateMany).not.toHaveBeenCalled();
    expect(mockArtifactCreate).not.toHaveBeenCalled();
    expect(mockRemoveObjects).not.toHaveBeenCalled();
    expect(mockStorageUpload).not.toHaveBeenCalled();
  });

  it("reclaims a stale PROCESSING attempt with a newer token and stores only a safe failure", async () => {
    const previousToken = new Date("2026-10-01T00:00:00.000Z");
    mockArtifactFindMany.mockResolvedValue([]);
    mockJobFindFirst.mockResolvedValue({
      id: "export-stale",
      status: "PROCESSING",
      startedAt: previousToken,
      organizationId: "org-1",
      requestedByMembershipId: "membership-1",
      kind: "FINANCE",
    });
    mockJobUpdateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 });
    mockMembershipFindUnique.mockResolvedValue({
      status: "ACTIVE",
      role: "MAINTAINER",
    });

    const result = await processDataExports();

    const claim = mockJobUpdateMany.mock.calls[0][0];
    expect(claim.where).toMatchObject({
      id: "export-stale",
      status: "PROCESSING",
      startedAt: previousToken,
    });
    expect(claim.data.startedAt.getTime()).toBeGreaterThan(
      previousToken.getTime(),
    );
    expect(mockArtifactCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        exportJobId: "export-stale",
        attemptStartedAt: claim.data.startedAt,
      }),
    });
    expect(result).toMatchObject({ failed: 1, success: false });
    expect(result.errors.join(" ")).not.toContain("Prisma");
    expect(mockJobUpdateMany.mock.calls[1][0].data.error).toBe(
      "The member who requested this export no longer has access to it.",
    );
    expect(mockRecordSystemError).toHaveBeenCalledTimes(1);
  });

  it("keeps READY when post-commit email and notification attempts throw", async () => {
    const originalUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const originalServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://storage.example";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";
    mockArtifactFindMany.mockResolvedValue([]);
    mockJobFindFirst.mockResolvedValue({
      id: "export-ready",
      status: "PENDING",
      startedAt: null,
      organizationId: "org-1",
      requestedByMembershipId: "membership-1",
      kind: "PEOPLE",
    });
    mockJobUpdateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 });
    mockArtifactUpdateMany.mockResolvedValue({ count: 1 });
    mockMembershipFindUnique.mockResolvedValue({
      status: "ACTIVE",
      role: "OWNER",
    });
    mockStageReadyEmail.mockResolvedValue([{ staged: null, message: {} }]);
    mockStageReadyNotification.mockResolvedValue([
      { id: "notice-1", status: "PENDING" },
    ]);
    mockAttemptStaged.mockRejectedValue(new Error("mail provider unavailable"));
    mockAttemptNotification.mockRejectedValue(
      new Error("notification provider unavailable"),
    );

    try {
      const result = await processDataExports();

      expect(result).toMatchObject({ succeeded: 1, failed: 0, success: true });
      expect(mockJobUpdateMany).toHaveBeenCalledTimes(2);
      expect(mockJobUpdateMany.mock.calls[1][0].data.status).toBe("READY");
      expect(mockAttemptStaged).toHaveBeenCalledTimes(1);
      expect(mockAttemptNotification).toHaveBeenCalledTimes(1);
    } finally {
      if (originalUrl === undefined)
        delete process.env.NEXT_PUBLIC_SUPABASE_URL;
      else process.env.NEXT_PUBLIC_SUPABASE_URL = originalUrl;
      if (originalServiceKey === undefined)
        delete process.env.SUPABASE_SERVICE_ROLE_KEY;
      else process.env.SUPABASE_SERVICE_ROLE_KEY = originalServiceKey;
    }
  });

  it("does not publish or stage from an attempt whose finalization CAS lost", async () => {
    const oldToken = new Date("2026-10-01T00:00:00.000Z");
    mockArtifactFindMany.mockResolvedValue([]);
    mockJobFindFirst.mockResolvedValue({
      id: "export-raced",
      status: "PROCESSING",
      startedAt: oldToken,
      organizationId: "org-1",
      requestedByMembershipId: "membership-1",
      kind: "PEOPLE",
    });
    mockJobUpdateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    mockMembershipFindUnique.mockResolvedValue({
      status: "ACTIVE",
      role: "OWNER",
    });

    const result = await processDataExports();

    const claimedAttempt = mockArtifactCreate.mock.calls[0][0].data;
    expect(claimedAttempt.attemptStartedAt.getTime()).toBeGreaterThan(
      oldToken.getTime(),
    );
    expect(claimedAttempt.storagePath).not.toBe(
      `org-1/export-raced/${oldToken.getTime()}.json`,
    );
    expect(result).toMatchObject({
      succeeded: 0,
      superseded: 1,
      success: true,
    });
    expect(mockJobUpdateMany).toHaveBeenCalledTimes(2);
    expect(mockJobUpdateMany.mock.calls[1][0].where).toMatchObject({
      status: "PROCESSING",
      startedAt: claimedAttempt.attemptStartedAt,
    });
    expect(
      mockJobUpdateMany.mock.calls.some(
        (call) => call[0].data.status === "FAILED",
      ),
    ).toBe(false);
    expect(mockAuditCreate).not.toHaveBeenCalled();
    expect(mockStageReadyEmail).not.toHaveBeenCalled();
    expect(mockStageReadyNotification).not.toHaveBeenCalled();
    expect(mockRecordSystemError).not.toHaveBeenCalled();
  });
});
