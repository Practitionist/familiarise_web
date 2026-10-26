/** @jest-environment node */

const mockOrganizations = jest.fn();
const mockMemberships = jest.fn();
const mockAudit = jest.fn();
const mockRecordings = jest.fn();
const mockClaimRecording = jest.fn();
const mockActiveTransfer = jest.fn();
const mockQueryTaggedChannels = jest.fn();
const mockLoadSurfaces = jest.fn();
const mockRevokeMember = jest.fn();
const mockReportSentryError = jest.fn();
const mockFreeze = jest.fn();
const mockDeleteRecordingObject = jest.fn();

type Channel = { id: string; type: "messaging" | "team"; frozen: boolean };
let channels: Channel[] = [];

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    organization: {
      findMany: (...args: unknown[]) => mockOrganizations(...args),
    },
    membership: { findMany: (...args: unknown[]) => mockMemberships(...args) },
    orgAuditLog: { create: (...args: unknown[]) => mockAudit(...args) },
    meeting: { findMany: jest.fn().mockResolvedValue([]) },
    webinarPlan: { findMany: jest.fn().mockResolvedValue([]) },
    classPlan: { findMany: jest.fn().mockResolvedValue([]) },
    recording: {
      findMany: (...args: unknown[]) => mockRecordings(...args),
      findFirst: (...args: unknown[]) => mockActiveTransfer(...args),
      updateManyAndReturn: (...args: unknown[]) => mockClaimRecording(...args),
    },
  },
}));
jest.mock("../../lib/redis", () => ({
  createCircuitBreaker: () => ({ run: (run: () => Promise<unknown>) => run() }),
}));
jest.mock("../../lib/stream-client", () => ({
  isStreamConfigured: () => true,
  isExpectedStreamError: (error: unknown) =>
    error instanceof Error && error.message === "channel missing",
  withStreamCircuitBreaker: jest.requireActual<
    typeof import("../../lib/stream-client")
  >("../../lib/stream-client").withStreamCircuitBreaker,
  getStreamChatClient: () => ({
    channel: (_type: string, id: string) => ({
      updatePartial: async () => {
        mockFreeze(id);
        const channel = channels.find((row) => row.id === id);
        if (channel) channel.frozen = true;
      },
    }),
  }),
}));
jest.mock("../../lib/stream/channel-administration", () => ({
  queryOrgTaggedChannels: (...args: unknown[]) =>
    mockQueryTaggedChannels(...args),
  endActiveStreamVideoCalls: jest.fn().mockResolvedValue({
    callsEnded: 0,
    errors: [],
  }),
}));
jest.mock("../../lib/stream/org-access-revocation", () => ({
  loadOrgStreamSurfaces: (...args: unknown[]) => mockLoadSurfaces(...args),
  revokeMemberStreamAccess: (...args: unknown[]) => mockRevokeMember(...args),
  STREAM_REVOCATION_RETRY_WINDOW_HOURS: 72,
  ORG_STREAM_SURFACE_LIMIT: 5000,
}));
jest.mock("../../lib/stream/batch", () => ({
  ...jest.requireActual<typeof import("../../lib/stream/batch")>(
    "../../lib/stream/batch",
  ),
  pause: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../../lib/cron/with-cron-lock", () => ({
  readJobCheckpoint: jest.fn().mockResolvedValue(null),
  withCronLock: (_job: string, _opts: unknown, run: () => Promise<unknown>) =>
    run(),
}));
jest.mock("../../lib/stream/recording-storage", () => ({
  deleteRecordingObject: (...args: unknown[]) =>
    mockDeleteRecordingObject(...args),
}));
jest.mock("../../lib/stream/recording-retention", () => ({
  purgeExpiredRecordingAssets: (
    row: { storagePath: string | null },
    reporter: unknown,
  ) => mockDeleteRecordingObject(row.storagePath, reporter),
}));
jest.mock("../../lib/supabase-storage-core", () => ({
  removeObjects: jest.fn().mockResolvedValue(true),
}));
jest.mock("../../lib/observability/report", () => ({
  reportSentryError: (...args: unknown[]) => mockReportSentryError(...args),
}));
jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));

import { readJobCheckpoint } from "../../lib/cron/with-cron-lock";
import { queryChannelsPaged } from "../../lib/stream/batch";
import { windDownDeactivatedOrgs } from "../../jobs/stream/wind-down-deactivated-orgs";

const oldDate = new Date("2025-01-01T00:00:00Z");
const org = {
  id: "org-a",
  deletedAt: oldDate,
  updatedAt: oldDate,
  streamRecordingRetentionDays: 30,
  auditLogs: [],
};

function selectFreshOrgs(rows = [org]) {
  mockOrganizations.mockResolvedValueOnce(rows).mockResolvedValueOnce([]);
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(readJobCheckpoint).mockResolvedValue(null);
  channels = [];
  mockOrganizations.mockResolvedValue([]);
  mockMemberships.mockResolvedValue([]);
  mockAudit.mockResolvedValue({});
  mockRecordings.mockResolvedValue([]);
  mockActiveTransfer.mockResolvedValue(null);
  mockClaimRecording.mockImplementation(async ({ where }) => [
    {
      id: where.id,
      storagePath: where.storagePath,
      streamCallId: null,
      streamRecordingId: null,
    },
  ]);
  mockDeleteRecordingObject.mockResolvedValue({ success: true });
  mockLoadSurfaces.mockResolvedValue({
    webinarIds: [],
    classIds: [],
    dmChannelIds: [],
  });
  mockRevokeMember.mockResolvedValue({ complete: true, failures: [] });
  mockQueryTaggedChannels.mockImplementation(() =>
    queryChannelsPaged(async ({ limit, offset }) =>
      channels
        .filter((channel) => !channel.frozen)
        .slice(offset, offset + limit),
    ),
  );
});

it("withholds both completion markers on truncation, then progresses when frozen channels leave the filter", async () => {
  channels = Array.from({ length: 1021 }, (_, i) => ({
    id: `dm-${i}`,
    type: "messaging",
    frozen: false,
  }));
  selectFreshOrgs();
  const first = await windDownDeactivatedOrgs();
  expect(first.success).toBe(false);
  expect(first.dmChannelsFrozen).toBe(1020);
  expect(first.errors).toEqual([expect.stringContaining("truncated")]);
  expect(mockAudit).not.toHaveBeenCalled();
  expect(mockQueryTaggedChannels).toHaveBeenCalledWith(
    expect.anything(),
    org.id,
    { frozen: false },
    { deadlineMs: expect.any(Number) },
  );

  selectFreshOrgs();
  const second = await windDownDeactivatedOrgs();
  expect(second.success).toBe(true);
  expect(second.dmChannelsFrozen).toBe(1);
  expect(mockAudit).toHaveBeenCalledWith({
    data: expect.objectContaining({ action: "STREAM_ORG_WOUND_DOWN" }),
  });
  expect(mockAudit).toHaveBeenCalledWith({
    data: expect.objectContaining({ action: "STREAM_ORG_RETENTION_COMPLETE" }),
  });
});

it("does not claim progress when an unchanged non-messaging prefix keeps hiding the tail", async () => {
  channels = [
    ...Array.from({ length: 1020 }, (_, i) => ({
      id: `team-${i}`,
      type: "team" as const,
      frozen: false,
    })),
    { id: "dm-tail", type: "messaging", frozen: false },
  ];
  for (let attempt = 0; attempt < 2; attempt++) {
    selectFreshOrgs();
    const result = await windDownDeactivatedOrgs();
    expect(result.success).toBe(false);
    expect(result.dmChannelsFrozen).toBe(0);
  }
  expect(mockAudit).not.toHaveBeenCalled();
  expect(mockFreeze).not.toHaveBeenCalled();
});

it.each(["vendor unavailable", "channel missing"])(
  "withholds both completion markers when channel enumeration fails: %s",
  async (message) => {
    selectFreshOrgs();
    mockQueryTaggedChannels.mockRejectedValueOnce(new Error(message));
    const result = await windDownDeactivatedOrgs();
    expect(result.success).toBe(false);
    expect(result.errors).toEqual([expect.stringContaining(message)]);
    expect(mockAudit).not.toHaveBeenCalled();
    expect(mockRecordings).toHaveBeenCalled();
  },
);

it("retains normal completion markers after a complete empty scan", async () => {
  selectFreshOrgs();
  const result = await windDownDeactivatedOrgs();
  expect(result.success).toBe(true);
  expect(mockAudit).toHaveBeenCalledTimes(2);
});

it("withholds retention completion after a channel freeze fails", async () => {
  selectFreshOrgs();
  channels = [{ id: "dm-a", type: "messaging", frozen: false }];
  mockFreeze.mockImplementationOnce(() => {
    throw new Error("freeze unavailable");
  });
  const result = await windDownDeactivatedOrgs();
  expect(result.success).toBe(false);
  expect(mockAudit).not.toHaveBeenCalled();
});

it("does not repeat a completed wind-down or mark a failed retention purge complete", async () => {
  mockOrganizations.mockResolvedValueOnce([]).mockResolvedValueOnce([
    {
      ...org,
      auditLogs: [{ action: "STREAM_ORG_WOUND_DOWN", createdAt: oldDate }],
    },
  ]);
  mockRecordings.mockResolvedValueOnce([
    {
      id: "recording-a",
      storagePath: "object-a",
      previewClipStoragePath: null,
    },
  ]);
  mockDeleteRecordingObject.mockResolvedValueOnce({
    success: false,
    error: "storage unavailable",
  });
  const result = await windDownDeactivatedOrgs();
  expect(result.success).toBe(false);
  expect(mockQueryTaggedChannels).not.toHaveBeenCalled();
  expect(mockAudit).not.toHaveBeenCalled();
});

it("keeps completion decisions isolated per organization while the fleet result remains unsuccessful", async () => {
  selectFreshOrgs([org, { ...org, id: "org-b" }]);
  mockQueryTaggedChannels.mockRejectedValueOnce(
    new Error("vendor unavailable"),
  );
  const result = await windDownDeactivatedOrgs();
  expect(result.success).toBe(false);
  expect(mockAudit).toHaveBeenCalledTimes(2);
  expect(mockAudit).toHaveBeenNthCalledWith(1, {
    data: expect.objectContaining({
      organizationId: "org-b",
      action: "STREAM_ORG_WOUND_DOWN",
    }),
  });
  expect(mockAudit).toHaveBeenNthCalledWith(2, {
    data: expect.objectContaining({
      organizationId: "org-b",
      action: "STREAM_ORG_RETENTION_COMPLETE",
    }),
  });
});

it("aggregates unexpected removed-member failures once per invocation", async () => {
  mockMemberships
    .mockResolvedValueOnce(
      Array.from({ length: 3 }, (_, i) => ({
        userId: `user-${i}`,
        organizationId: org.id,
      })),
    )
    .mockResolvedValueOnce([]);
  mockRevokeMember.mockRejectedValue(new Error("revocation unavailable"));
  const result = await windDownDeactivatedOrgs();
  expect(result.success).toBe(false);
  expect(result.errors).toHaveLength(3);
  expect(mockReportSentryError).toHaveBeenCalledTimes(1);
  expect(mockReportSentryError).toHaveBeenCalledWith(
    expect.any(Error),
    expect.objectContaining({
      op: "wind-down-deactivated-orgs",
      extra: expect.objectContaining({ count: 3 }),
    }),
  );
  mockMemberships
    .mockResolvedValueOnce([{ userId: "retry-user", organizationId: org.id }])
    .mockResolvedValueOnce([]);
  await windDownDeactivatedOrgs();
  expect(mockReportSentryError).toHaveBeenCalledTimes(2);
  expect(mockReportSentryError).toHaveBeenLastCalledWith(
    expect.any(Error),
    expect.objectContaining({ extra: expect.objectContaining({ count: 1 }) }),
  );
});

it("aggregates channel failures captured inside the shared circuit breaker", async () => {
  selectFreshOrgs();
  channels = Array.from({ length: 3 }, (_, i) => ({
    id: `dm-${i}`,
    type: "messaging",
    frozen: false,
  }));
  for (const _channel of channels) {
    mockFreeze.mockImplementationOnce(() => {
      throw new Error("freeze unavailable");
    });
  }
  const result = await windDownDeactivatedOrgs();
  expect(result.success).toBe(false);
  expect(result.errors).toHaveLength(3);
  expect(mockReportSentryError).toHaveBeenCalledTimes(1);
  expect(mockReportSentryError).toHaveBeenCalledWith(
    expect.any(Error),
    expect.objectContaining({
      op: "wind-down-deactivated-orgs",
      extra: expect.objectContaining({ count: 3 }),
    }),
  );
  expect(mockAudit).not.toHaveBeenCalled();
});

it("preserves billing classification after earlier failures fill the bounded sample", async () => {
  selectFreshOrgs();
  channels = Array.from({ length: 12 }, (_, i) => ({
    id: `dm-${i}`,
    type: "messaging",
    frozen: false,
  }));
  const billingError = Object.assign(new Error("billing refused"), {
    code: 99,
  });
  for (let i = 0; i < channels.length; i++) {
    const error =
      i === 11
        ? billingError
        : new Error(
            i === 0 ? "circuit breaker is OPEN" : "transport unavailable",
          );
    mockFreeze.mockImplementationOnce(() => {
      throw error;
    });
  }
  const result = await windDownDeactivatedOrgs();
  expect(result.success).toBe(false);
  expect(result.errors).toHaveLength(12);
  expect(mockReportSentryError).toHaveBeenCalledTimes(1);
  expect(mockReportSentryError).toHaveBeenCalledWith(
    billingError,
    expect.objectContaining({
      level: "error",
      tags: { reason: "stream.billing" },
      extra: { count: 12, sample: expect.any(Array) },
    }),
  );
  expect(mockReportSentryError.mock.calls[0][1].extra.sample).toHaveLength(10);
});

it("claims EXPIRED before vendor deletion and never admits an active copy", async () => {
  selectFreshOrgs();
  mockRecordings.mockResolvedValueOnce([
    {
      id: "r",
      status: "READY",
      storagePath: "old-key",
      previewClipStoragePath: null,
    },
  ]);
  const order: string[] = [];
  mockClaimRecording.mockImplementationOnce(async () => {
    order.push("claim");
    return [
      {
        id: "r",
        storagePath: "old-key",
        streamCallId: null,
        streamRecordingId: null,
      },
    ];
  });
  mockDeleteRecordingObject.mockImplementationOnce(async () => {
    order.push("delete");
    return { success: true };
  });
  expect((await windDownDeactivatedOrgs()).recordingsPurged).toBe(1);
  expect(order).toEqual(["claim", "delete"]);
  expect(mockClaimRecording.mock.calls[0][0]).toMatchObject({
    where: {
      id: "r",
      storagePath: "old-key",
      purchases: { none: {} },
      status: { in: ["READY", "AVAILABLE", "EXPIRED"] },
    },
    data: { status: "EXPIRED" },
  });
});

it("performs no vendor deletion after a lost expiry claim and withholds retention completion", async () => {
  selectFreshOrgs();
  mockRecordings.mockResolvedValueOnce([
    {
      id: "r",
      status: "READY",
      storagePath: "old-key",
      previewClipStoragePath: null,
    },
  ]);
  mockClaimRecording.mockResolvedValueOnce([]);
  expect((await windDownDeactivatedOrgs()).success).toBe(false);
  expect(mockDeleteRecordingObject).not.toHaveBeenCalled();
  expect(
    mockAudit.mock.calls.some(
      ([arg]) => arg.data.action === "STREAM_ORG_RETENTION_COMPLETE",
    ),
  ).toBe(false);
});

it("does not certify retention while a recording transfer remains active", async () => {
  selectFreshOrgs();
  mockActiveTransfer.mockResolvedValueOnce({ id: "copy-in-flight" });
  expect((await windDownDeactivatedOrgs()).success).toBe(false);
  expect(
    mockAudit.mock.calls.some(
      ([arg]) => arg.data.action === "STREAM_ORG_RETENTION_COMPLETE",
    ),
  ).toBe(false);
});

it("stops starting channel batches after its run budget and leaves completion unwritten", async () => {
  let now = Date.now();
  const clock = jest.spyOn(Date, "now").mockImplementation(() => now);
  try {
    selectFreshOrgs();
    channels = Array.from({ length: 20 }, (_, i) => ({
      id: `dm-${i}`,
      type: "messaging",
      frozen: false,
    }));
    mockFreeze.mockImplementationOnce(() => {
      now += 6 * 60_000;
    });
    const result = await windDownDeactivatedOrgs();
    expect(result.success).toBe(false);
    expect(mockFreeze).toHaveBeenCalledTimes(10);
    expect(mockAudit).not.toHaveBeenCalled();
  } finally {
    clock.mockRestore();
  }
});

it("rotates removed-membership recovery past a persistent processed prefix", async () => {
  const rows = Array.from({ length: 11 }, (_, i) => ({
    id: String(i).padStart(3, "0"),
    userId: `user-${i}`,
    organizationId: org.id,
    updatedAt: new Date(),
  }));
  mockMemberships.mockImplementation(async ({ where, take }) =>
    where.status === "REMOVED"
      ? rows.filter((row) => !where.id || row.id > where.id.gt).slice(0, take)
      : [],
  );
  const first = await windDownDeactivatedOrgs();
  jest.mocked(readJobCheckpoint).mockResolvedValue(first.checkpoint);
  const second = await windDownDeactivatedOrgs();
  expect(first.removedMembersDrained).toBe(10);
  expect(second.removedMembersDrained).toBe(1);
  expect(mockRevokeMember).toHaveBeenLastCalledWith(
    expect.objectContaining({
      userId: "user-10",
      revokeTokensIssuedBefore: rows[10].updatedAt,
    }),
  );
});

it("withholds completion after a bounded database surface scan is truncated", async () => {
  selectFreshOrgs();
  mockLoadSurfaces.mockResolvedValueOnce({
    webinarIds: [],
    classIds: [],
    dmChannelIds: [],
    truncated: true,
  });
  expect((await windDownDeactivatedOrgs()).success).toBe(false);
  expect(mockAudit).not.toHaveBeenCalled();
});

it.each(["legacy-bare-id", '{"organization":17,"membership":null}'])(
  "refuses malformed checkpoint %s before vendor work",
  async (checkpoint) => {
    jest.mocked(readJobCheckpoint).mockResolvedValue(checkpoint);
    await expect(windDownDeactivatedOrgs()).rejects.toThrow();
    expect(mockQueryTaggedChannels).not.toHaveBeenCalled();
    expect(mockFreeze).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
  },
);
