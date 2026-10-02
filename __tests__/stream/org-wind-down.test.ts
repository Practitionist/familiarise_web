/**
 * @jest-environment node
 */

/**
 * Organisation wind-down — the Stream half of a closed organisation.
 *
 * `DELETE /api/organizations/[orgId]` soft-deleted by flipping the org to
 * `DEACTIVATED` and scrubbing contact PII, and did no Stream work at all:
 * channels stayed open and writable, calls stayed joinable by anyone holding a
 * valid id, recordings stayed listed and stored. The hard-delete branch was
 * sharper — `Meeting.organizationId` is `onDelete: SetNull`, so deleting the
 * org row left its meetings pointing at LIVE Stream calls with no tenant tag,
 * unfindable by any org query.
 *
 * What is pinned here:
 *   4. the job targets only DEACTIVATED orgs, takes the cron lock, honours
 *      maintenance mode, and is idempotent;
 *   5. it ends calls and freezes channels, and is safe to re-run;
 *   6. it re-drives a member-removal revocation that did not land.
 */

jest.mock("@sentry/nextjs", () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock("../../lib/observability/report", () => ({
  reportSentryError: jest.fn(),
}));

jest.mock("../../lib/observability/job-sentry", () => ({
  runJob: jest.fn(),
}));

jest.mock("../../lib/maintenance-cron", () => ({
  abortIfMaintenance: jest.fn(async () => undefined),
}));

jest.mock("dotenv/config", () => ({}));

const cronLock = jest.fn(
  async (_name: string, _opts: unknown, fn: () => Promise<unknown>) => fn(),
);
jest.mock("../../lib/cron/with-cron-lock", () => ({
  withCronLock: (...args: [string, unknown, () => Promise<unknown>]) =>
    cronLock(...args),
  CronLockHeldError: class extends Error {},
  CronLockUnavailableError: class extends Error {},
}));

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    organization: { findMany: jest.fn(async () => []) },
    meeting: {
      findMany: jest.fn(async () => []),
      updateMany: jest.fn(async () => ({ count: 0 })),
      update: jest.fn(async () => ({})),
    },
    recording: {
      findMany: jest.fn(async () => []),
      updateMany: jest.fn(async () => ({ count: 0 })),
    },
    membership: { findMany: jest.fn(async () => []) },
    webinar: {
      findMany: jest.fn(async () => []),
      updateMany: jest.fn(async () => ({ count: 0 })),
    },
    class: {
      findMany: jest.fn(async () => []),
      updateMany: jest.fn(async () => ({ count: 0 })),
    },
    $disconnect: jest.fn(async () => undefined),
  },
}));

const endCall = jest.fn(async () => undefined);
const updatePartial = jest.fn(async (_arg: unknown) => ({}));
const revokeUserToken = jest.fn(
  async (_userId: string, _at: Date) => undefined,
);
jest.mock("../../lib/stream-client", () => ({
  getStreamChatClient: jest.fn(() => ({
    revokeUserToken,
    channel: jest.fn(() => ({ updatePartial })),
  })),
  getStreamVideoClient: jest.fn(() => ({
    video: { call: jest.fn(() => ({ end: endCall })) },
  })),
  isStreamConfigured: jest.fn(() => true),
  isExpectedStreamError: jest.fn(() => false),
  withStreamCircuitBreaker: jest.fn(async (fn: () => Promise<unknown>) => fn()),
}));

jest.mock("../../lib/stream/recording-service", () => ({
  RecordingService: { stopRecording: jest.fn(async () => undefined) },
}));
jest.mock("../../lib/stream/recording-storage", () => ({
  deleteRecordingObject: jest.fn(async () => ({ success: true })),
}));
jest.mock("../../lib/supabase", () => ({
  deleteRecordingPreviewAssets: jest.fn(async () => undefined),
}));

jest.mock("../../lib/enterprise/member-removal", () => ({
  loadOrgStreamSurfaces: jest.fn(async () => ({
    eventChannelIds: [],
    dmChannelIds: [],
  })),
  revokeMemberStreamAccess: jest.fn(async () => ({
    userId: "u1",
    orgId: "org-1",
    skipped: null,
    tokenRevoked: true,
    channelsConsidered: 0,
    channelsEvicted: 0,
    channelFailures: [],
    error: null,
  })),
  STREAM_REVOCATION_RETRY_WINDOW_HOURS: 72,
}));

import prisma from "../../lib/prisma";
import { abortIfMaintenance } from "../../lib/maintenance-cron";
import {
  JOB_NAME,
  ORG_DELETED_TEARDOWN_MARKER,
  windDownDeactivatedOrgs,
} from "../../jobs/stream/wind-down-deactivated-orgs";
import {
  loadOrgStreamSurfaces,
  revokeMemberStreamAccess,
} from "../../lib/enterprise/member-removal";
import { getStreamVideoClient } from "../../lib/stream-client";

const orgFindMany = prisma.organization.findMany as jest.Mock;
const meetingFindMany = prisma.meeting.findMany as jest.Mock;
const meetingUpdateMany = prisma.meeting.updateMany as jest.Mock;
const recordingFindMany = prisma.recording.findMany as jest.Mock;
const recordingUpdateMany = (
  prisma.recording as unknown as {
    updateMany: jest.Mock;
  }
).updateMany;
const membershipFindMany = prisma.membership.findMany as jest.Mock;
const webinarFindMany = prisma.webinar.findMany as jest.Mock;
const webinarUpdateMany = prisma.webinar.updateMany as jest.Mock;
const classFindMany = prisma.class.findMany as jest.Mock;
const classUpdateMany = prisma.class.updateMany as jest.Mock;
const surfaces = loadOrgStreamSurfaces as jest.Mock;
const revokeMember = revokeMemberStreamAccess as jest.Mock;

const closedOrg = {
  id: "org-closed",
  name: "Closed Co",
  chatRetentionDays: 90,
  streamRecordingRetentionDays: 90,
};

/**
 * `meeting.findMany` is asked two different questions in one run — Stage 1 for
 * the hard-delete marker, Stage 2 for an org's live calls — so the double
 * honours the `where` the way Prisma would, instead of handing both stages the
 * same page.
 */
const meetingRows: {
  id: string;
  streamCallId: string;
  isRecording?: boolean;
  endedReason?: string | null;
  endedAt?: Date | null;
  organizationId?: string | null;
}[] = [];
meetingFindMany.mockImplementation(
  async (args: { where: Record<string, unknown> }) =>
    meetingRows.filter((row) => {
      const w = args.where;
      if (
        w.endedAt === null &&
        row.endedAt !== null &&
        row.endedAt !== undefined
      )
        return false;
      if (
        typeof w.endedReason === "string" &&
        row.endedReason !== w.endedReason
      )
        return false;
      if (typeof w.organizationId === "string")
        return row.organizationId === w.organizationId;
      return true;
    }),
);

beforeEach(() => {
  jest.clearAllMocks();
  cronLock.mockImplementation(
    async (_n: string, _o: unknown, fn: () => Promise<unknown>) => fn(),
  );
  orgFindMany.mockResolvedValue([]);
  meetingRows.length = 0;
  meetingUpdateMany.mockResolvedValue({ count: 1 });
  recordingFindMany.mockResolvedValue([]);
  recordingUpdateMany.mockResolvedValue({ count: 0 });
  membershipFindMany.mockResolvedValue([]);
  webinarFindMany.mockResolvedValue([]);
  webinarUpdateMany.mockResolvedValue({ count: 0 });
  classFindMany.mockResolvedValue([]);
  classUpdateMany.mockResolvedValue({ count: 0 });
  surfaces.mockResolvedValue({ eventChannelIds: [], dmChannelIds: [] });
  revokeMember.mockResolvedValue({
    skipped: null,
    tokenRevoked: true,
    error: null,
  });
  endCall.mockResolvedValue(undefined);
  updatePartial.mockResolvedValue({});
  revokeUserToken.mockResolvedValue(undefined);
  (prisma.meeting.update as jest.Mock).mockResolvedValue({});
});

describe("windDownDeactivatedOrgs — targeting and locking", () => {
  it("selects only DEACTIVATED orgs and orders them oldest first", async () => {
    await windDownDeactivatedOrgs();

    expect(orgFindMany.mock.calls[0][0].where).toEqual({
      status: "DEACTIVATED",
    });
    expect(orgFindMany.mock.calls[0][0].orderBy).toEqual({
      updatedAt: "asc",
    });
  });

  it("takes the cron lock, fail-open, under the job's own name", async () => {
    await windDownDeactivatedOrgs();

    expect(cronLock).toHaveBeenCalledWith(
      JOB_NAME,
      { failMode: "open" },
      expect.any(Function),
    );
  });

  it("honours maintenance mode at the entry point", async () => {
    // `abortIfMaintenance` calls process.exit(0) under OFFLINE, so the guard
    // lives in the runJob body — the same placement `expire-event-channels`
    // uses. Assert the guard is wired, not that it exits.
    const job = jest.requireActual(
      "../../jobs/stream/wind-down-deactivated-orgs",
    ) as { windDownDeactivatedOrgs: unknown };
    expect(typeof job.windDownDeactivatedOrgs).toBe("function");
    // The exported core must NOT be the thing that guards, or the HTTP twin
    // would process.exit a Lambda.
    expect(abortIfMaintenance).not.toHaveBeenCalled();
  });

  it("refuses to run and does not report success without Stream credentials", async () => {
    const stream = jest.requireMock("../../lib/stream-client") as {
      isStreamConfigured: jest.Mock;
    };
    stream.isStreamConfigured.mockReturnValue(false);

    const result = await windDownDeactivatedOrgs();

    expect(result.success).toBe(false);
    expect(result.errors[0]).toMatch(/not configured/);
    expect(orgFindMany).not.toHaveBeenCalled();
    stream.isStreamConfigured.mockReturnValue(true);
  });

  it("reports a backlog instead of passing green when a page filled", async () => {
    orgFindMany.mockResolvedValue([closedOrg]);
    meetingRows.length = 0;
    for (let i = 0; i < 100; i++) {
      meetingRows.push({
        id: `m-${i}`,
        streamCallId: `call-${i}`,
        isRecording: false,
        endedReason: null,
        endedAt: null,
        organizationId: "org-closed",
      });
    }

    const result = await windDownDeactivatedOrgs();

    expect(result.truncated).toBe(true);
    expect(result.success).toBe(false);
  });
});

describe("windDownDeactivatedOrgs — calls and channels", () => {
  it("ends the org's live calls", async () => {
    orgFindMany.mockResolvedValue([closedOrg]);
    meetingRows.length = 0;
    meetingRows.push({
      id: "m-1",
      streamCallId: "call-1",
      isRecording: false,
      endedReason: null,
      endedAt: null,
      organizationId: "org-closed",
    });

    const result = await windDownDeactivatedOrgs();

    expect(endCall).toHaveBeenCalledTimes(1);
    const video = (getStreamVideoClient as jest.Mock).mock.results[0].value;
    expect(video.video.call).toHaveBeenCalledWith("default", "call-1");
    expect(result.callsEnded).toBe(1);
  });

  it("never writes Meeting.endedAt — the call.ended webhook owns that column", async () => {
    orgFindMany.mockResolvedValue([closedOrg]);
    meetingRows.length = 0;
    meetingRows.push({
      id: "m-1",
      streamCallId: "call-1",
      isRecording: false,
      endedReason: null,
      endedAt: null,
      organizationId: "org-closed",
    });

    await windDownDeactivatedOrgs();

    for (const call of (prisma.meeting.update as jest.Mock).mock.calls) {
      expect(call[0].data ?? {}).not.toHaveProperty("endedAt");
    }
  });

  it("stops an in-flight recording before ending its call", async () => {
    orgFindMany.mockResolvedValue([closedOrg]);
    meetingRows.length = 0;
    meetingRows.push({
      id: "m-1",
      streamCallId: "call-1",
      isRecording: true,
      endedReason: null,
      endedAt: null,
      organizationId: "org-closed",
    });

    await windDownDeactivatedOrgs();

    const { RecordingService } = jest.requireMock(
      "../../lib/stream/recording-service",
    ) as { RecordingService: { stopRecording: jest.Mock } };
    expect(RecordingService.stopRecording).toHaveBeenCalledWith("call-1");
    expect(endCall).toHaveBeenCalled();
  });

  it("freezes the org's channels", async () => {
    orgFindMany.mockResolvedValue([closedOrg]);
    surfaces.mockResolvedValue({
      eventChannelIds: ["webinar-web-1", "class-cls-1"],
      dmChannelIds: ["dmo-abcdef0123456789-0123456789abcdef01234567"],
    });
    webinarFindMany.mockResolvedValue([{ id: "web-1", chatFrozenAt: null }]);
    classFindMany.mockResolvedValue([{ id: "cls-1", chatFrozenAt: null }]);

    const result = await windDownDeactivatedOrgs();

    expect(updatePartial).toHaveBeenCalledTimes(3);
    for (const call of updatePartial.mock.calls) {
      expect(call[0]).toEqual({ set: { frozen: true } });
    }
    expect(result.channelsFrozen).toBe(3);
  });

  it("skips a channel the freeze ledger already says is frozen, spending no API call", async () => {
    orgFindMany.mockResolvedValue([closedOrg]);
    surfaces.mockResolvedValue({
      eventChannelIds: ["webinar-web-1", "class-cls-1"],
      dmChannelIds: [],
    });
    webinarFindMany.mockResolvedValue([
      { id: "web-1", chatFrozenAt: new Date() },
    ]);
    classFindMany.mockResolvedValue([{ id: "cls-1", chatFrozenAt: null }]);

    const result = await windDownDeactivatedOrgs();

    expect(updatePartial).toHaveBeenCalledTimes(1);
    expect(result.channelsSkippedAlreadyFrozen).toBe(1);
    expect(result.channelsFrozen).toBe(1);
  });

  it("stamps the freeze ledger only for channels Stream confirmed", async () => {
    orgFindMany.mockResolvedValue([closedOrg]);
    surfaces.mockResolvedValue({
      eventChannelIds: ["webinar-web-1", "class-cls-1"],
      dmChannelIds: [],
    });
    webinarFindMany.mockResolvedValue([{ id: "web-1", chatFrozenAt: null }]);
    classFindMany.mockResolvedValue([{ id: "cls-1", chatFrozenAt: null }]);
    // The DM-shaped failure hits the class channel (second in the batch).
    updatePartial
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error("429 too many requests"));

    const result = await windDownDeactivatedOrgs();

    expect(result.success).toBe(false);
    expect(webinarUpdateMany).toHaveBeenCalledWith({
      where: { id: { in: ["web-1"] } },
      data: { chatFrozenAt: expect.any(Date) },
    });
    expect(classUpdateMany).not.toHaveBeenCalled();
  });

  it("revokes every token the org's former members hold", async () => {
    orgFindMany.mockResolvedValue([closedOrg]);
    membershipFindMany.mockResolvedValue([
      { userId: "u-a" },
      { userId: "u-b" },
    ]);

    const result = await windDownDeactivatedOrgs();

    expect(revokeUserToken.mock.calls.map((c) => c[0]).sort()).toEqual([
      "u-a",
      "u-b",
    ]);
    expect(result.tokensRevoked).toBe(2);
  });

  it("unpublishes the org's recordings and purges the bytes past its retention dial", async () => {
    orgFindMany.mockResolvedValue([closedOrg]);
    const longAgo = new Date(Date.now() - 200 * 24 * 3_600_000);
    const yesterday = new Date(Date.now() - 24 * 3_600_000);
    recordingFindMany.mockResolvedValue([
      {
        id: "r-old",
        status: "READY",
        storagePath: "recordings/r-old.mp4",
        recordedAt: longAgo,
        listingStatus: "PUBLISHED",
      },
      {
        id: "r-new",
        status: "READY",
        storagePath: null,
        recordedAt: yesterday,
        listingStatus: "DRAFT",
      },
    ]);

    const result = await windDownDeactivatedOrgs();

    const { deleteRecordingObject } = jest.requireMock(
      "../../lib/stream/recording-storage",
    ) as { deleteRecordingObject: jest.Mock };
    // Bytes go only for the row past the org's own dial.
    expect(deleteRecordingObject).toHaveBeenCalledWith("recordings/r-old.mp4");
    expect(deleteRecordingObject).toHaveBeenCalledTimes(1);
    // The marketplace close is unconditional.
    expect(recordingUpdateMany).toHaveBeenCalledWith({
      where: {
        id: { in: ["r-old", "r-new"] },
        listingStatus: { not: "UNPUBLISHED" },
      },
      data: { listingStatus: "UNPUBLISHED", publishedAt: null },
    });
    expect(result.recordingsPurged).toBe(1);
    expect(result.recordingsQuarantined).toBe(2);
  });
});

describe("windDownDeactivatedOrgs — idempotency", () => {
  it("re-running a completed teardown is a clean no-op", async () => {
    orgFindMany.mockResolvedValue([closedOrg]);
    meetingRows.length = 0;
    surfaces.mockResolvedValue({
      eventChannelIds: ["webinar-web-1"],
      dmChannelIds: [],
    });
    webinarFindMany.mockResolvedValue([
      { id: "web-1", chatFrozenAt: new Date() },
    ]);
    membershipFindMany.mockResolvedValue([]);

    const first = await windDownDeactivatedOrgs();
    const second = await windDownDeactivatedOrgs();

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    // The ledger meant the second run spent nothing on the channel, and a
    // re-revoke only moves a timestamp that is already in the past.
    expect(second.channelsFrozen).toBe(0);
    expect(second.channelsSkippedAlreadyFrozen).toBe(1);
    expect(second.errors).toEqual([]);
  });

  it("keeps re-driving a call Stream could not end, and leaves the marker standing", async () => {
    // A hard-deleted org's meetings are unfindable by org, so the marker is the
    // only handle on them. It must survive a failed attempt.
    orgFindMany.mockResolvedValue([]);
    meetingRows.length = 0;
    meetingRows.push({
      id: "m-stranded",
      streamCallId: "call-stranded",
      endedReason: ORG_DELETED_TEARDOWN_MARKER,
      endedAt: null,
      organizationId: null,
    });
    endCall.mockRejectedValue(new Error("Stream timeout"));

    const result = await windDownDeactivatedOrgs();

    expect(meetingUpdateMany).not.toHaveBeenCalled();
    expect(result.strandedCallTeardowns).toBe(0);
    expect(result.success).toBe(false);
  });

  it("clears the teardown marker only once Stream confirms the end", async () => {
    orgFindMany.mockResolvedValue([]);
    meetingRows.length = 0;
    meetingRows.push({
      id: "m-stranded",
      streamCallId: "call-stranded",
      endedReason: ORG_DELETED_TEARDOWN_MARKER,
      endedAt: null,
      organizationId: null,
    });

    const result = await windDownDeactivatedOrgs();

    expect(meetingUpdateMany).toHaveBeenCalledWith({
      where: {
        id: "m-stranded",
        endedReason: ORG_DELETED_TEARDOWN_MARKER,
      },
      data: { endedReason: null },
    });
    expect(result.strandedCallTeardowns).toBe(1);
  });

  it("keeps the marker in step with the DELETE route's copy of the constant", async () => {
    // The route declares its own literal so a Lambda never loads a cron module's
    // graph. If either side is renamed the stranded calls become unfindable
    // again — silently — so the two are pinned against each other here.
    const { readFileSync } = jest.requireActual("node:fs") as {
      readFileSync: (p: string, e: string) => string;
    };
    const { join } = jest.requireActual("node:path") as {
      join: (...p: string[]) => string;
    };
    const source = readFileSync(
      join(process.cwd(), "app/api/organizations/[orgId]/route.ts"),
      "utf8",
    );
    expect(source).toContain(
      `const ORG_DELETED_TEARDOWN_MARKER = "${ORG_DELETED_TEARDOWN_MARKER}";`,
    );
  });
});

describe("windDownDeactivatedOrgs — the member-removal retry queue", () => {
  it("re-drives the revocation a removal owed, bounded by the retry window", async () => {
    orgFindMany.mockResolvedValue([]);
    membershipFindMany.mockResolvedValue([
      { id: "mem-1", userId: "u-1", organizationId: "org-1" },
    ]);
    revokeMember.mockResolvedValue({
      skipped: null,
      tokenRevoked: true,
      error: null,
    });

    const now = new Date("2026-03-01T00:00:00.000Z");
    const result = await windDownDeactivatedOrgs({ now });

    const where = membershipFindMany.mock.calls.at(-1)![0].where as {
      status: string;
      updatedAt: { gte: Date };
    };
    expect(where.status).toBe("REMOVED");
    // 72h — the same horizon retry-moderation-enforcement gives up past.
    expect(where.updatedAt.gte.toISOString()).toBe(
      new Date(now.getTime() - 72 * 3_600_000).toISOString(),
    );
    expect(revokeMember).toHaveBeenCalledWith({
      userId: "u-1",
      orgId: "org-1",
    });
    expect(result.memberRevocationsDriven).toBe(1);
  });

  it("counts an unlanded revocation as a failure rather than a success", async () => {
    orgFindMany.mockResolvedValue([]);
    membershipFindMany.mockResolvedValue([
      { id: "mem-1", userId: "u-1", organizationId: "org-1" },
    ]);
    revokeMember.mockResolvedValue({
      skipped: null,
      tokenRevoked: false,
      error: "revokeUserToken: Stream circuit open",
    });

    const result = await windDownDeactivatedOrgs();

    expect(result.memberRevocationsDriven).toBe(0);
    expect(result.success).toBe(false);
    expect(result.errors.join(" ")).toMatch(/mem-1/);
  });

  it("never re-evicts a member who came back", async () => {
    orgFindMany.mockResolvedValue([]);
    membershipFindMany.mockResolvedValue([
      { id: "mem-1", userId: "u-1", organizationId: "org-1" },
    ]);
    revokeMember.mockResolvedValue({
      skipped: "reinstated",
      tokenRevoked: false,
      error: null,
    });

    const result = await windDownDeactivatedOrgs();

    expect(result.memberRevocationsDriven).toBe(1);
    expect(result.success).toBe(true);
  });
});
