/** @jest-environment node */

const mockOrganizations = jest.fn();
const mockMemberships = jest.fn();
const mockAudit = jest.fn();
const mockRecordings = jest.fn();
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
    recording: { findMany: (...args: unknown[]) => mockRecordings(...args) },
  },
}));
jest.mock("../../lib/stream-client", () => ({
  isStreamConfigured: () => true,
  isExpectedStreamError: (error: unknown) =>
    error instanceof Error && error.message === "channel missing",
  withStreamCircuitBreaker: (run: () => Promise<unknown>) => run(),
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
jest.mock("../../lib/stream/event-channel-service", () => ({
  queryOrgTaggedChannels: (...args: unknown[]) =>
    mockQueryTaggedChannels(...args),
  endActiveStreamVideoCalls: jest.fn().mockResolvedValue({
    callsEnded: 0,
    errors: [],
  }),
}));
jest.mock("../../lib/enterprise/member-removal", () => ({
  loadOrgStreamSurfaces: (...args: unknown[]) => mockLoadSurfaces(...args),
  revokeMemberStreamAccess: (...args: unknown[]) => mockRevokeMember(...args),
  STREAM_REVOCATION_RETRY_WINDOW_HOURS: 72,
}));
jest.mock("../../lib/stream/batch", () => ({
  ...jest.requireActual<typeof import("../../lib/stream/batch")>(
    "../../lib/stream/batch",
  ),
  pause: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../../lib/cron/with-cron-lock", () => ({
  withCronLock: (_job: string, _opts: unknown, run: () => Promise<unknown>) =>
    run(),
}));
jest.mock("../../lib/stream/recording-storage", () => ({
  deleteRecordingObject: (...args: unknown[]) =>
    mockDeleteRecordingObject(...args),
}));
jest.mock("../../lib/supabase-storage-core", () => ({
  removeObjects: jest.fn().mockResolvedValue(true),
}));
jest.mock("../../lib/observability/report", () => ({
  reportSentryError: (...args: unknown[]) => mockReportSentryError(...args),
}));
jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));

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
  channels = [];
  mockOrganizations.mockResolvedValue([]);
  mockMemberships.mockResolvedValue([]);
  mockAudit.mockResolvedValue({});
  mockRecordings.mockResolvedValue([]);
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
      op: "wind-down-member-removal",
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
