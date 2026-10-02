/**
 * @jest-environment node
 */

/**
 * `DELETE /api/organizations/[orgId]` — the hard-delete branch must not orphan
 * its Stream calls.
 *
 * `Meeting.organizationId` and `Recording.organizationId` are both
 * `onDelete: SetNull`. Deleting the `Organization` row therefore left the
 * `Meeting` rows pointing at LIVE Stream call ids with no tenant tag at all —
 * orphaned, unattributable calls that no org query could ever find again, and
 * recordings the retention cron (which keys on organizationId) could never
 * reach either.
 *
 * So the branch captures the teardown targets and MARKS them inside the same
 * transaction that removes the org: `Meeting.endedReason = "org_deleted"` is what
 * `jobs/stream/wind-down-deactivated-orgs` Stage 1 drains, and unpublishing the
 * recordings is a pure local write that must be atomic with the org row
 * disappearing. The bytes and the Stream calls are settled AFTER the commit —
 * a provider call never runs inside a Prisma transaction.
 */

jest.mock("@sentry/nextjs", () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock("../../lib/auth-helpers", () => ({
  requireOrgAccess: jest.fn(async () => ({
    error: null,
    member: { id: "mem-owner", role: "OWNER" },
    session: { user: { id: "user-owner" } },
  })),
  isPrivileged: jest.fn(() => false),
}));

jest.mock("../../lib/data/org-details-include", () => ({
  orgDetailsInclude: {},
  redactOrgDetailsForRole: jest.fn((x: unknown) => x),
  suspendedOrgDetails: {},
}));

jest.mock("../../lib/auth/org-permissions", () => ({
  hasOrgPermission: jest.fn(() => true),
}));

jest.mock("../../lib/enterprise/audit-actions", () => ({
  AUDIT_ACTIONS: { SETTINGS: { ORG_SOFT_DELETED: "ORG_SOFT_DELETED" } },
}));

jest.mock("../../lib/enterprise/transitions", () => ({
  transitionOrganization: jest.fn(async () => undefined),
}));

jest.mock("../../lib/db/serializable-retry", () => ({
  withSerializableRetry: jest.fn(async (fn: () => Promise<unknown>) => fn()),
}));

jest.mock("../../lib/data/public-cache", () => ({
  purgeOrgSurfaces: jest.fn(async () => undefined),
}));

jest.mock("../../lib/payments/tax/pan-crypto", () => ({
  encryptPAN: jest.fn(() => "enc"),
}));

jest.mock("../../lib/compliance/state-codes", () => ({
  numericStateCode: jest.fn(() => "07"),
}));

jest.mock("../../lib/observability/report", () => ({
  reportSentryError: jest.fn(),
}));

jest.mock("../../lib/stream/recording-storage", () => ({
  deleteRecordingObject: jest.fn(async () => ({ success: true })),
}));

jest.mock("../../lib/supabase", () => ({
  deleteRecordingPreviewAssets: jest.fn(async () => undefined),
}));

const endCall = jest.fn(async () => undefined);
jest.mock("../../lib/stream-client", () => ({
  getStreamVideoClient: jest.fn(() => ({
    video: { call: jest.fn(() => ({ end: endCall })) },
  })),
  getStreamChatClient: jest.fn(() => ({})),
  isExpectedStreamError: jest.fn(() => false),
  withStreamCircuitBreaker: jest.fn(async (fn: () => Promise<unknown>) => fn()),
}));

jest.mock("../../lib/stream/call-cid", () => ({
  STREAM_CALL_TYPE: "default",
  toCallId: jest.fn((id: string) => id),
}));

/** A money-untouched shell: no history, so the branch hard-deletes. */
const shellOrg = {
  id: "org-1",
  deletedAt: null,
  billingAccount: null,
  _count: {
    contracts: 0,
    invoices: 0,
    purchaseOrders: 0,
    earnings: 0,
    payouts: 0,
  },
};

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    $transaction: jest.fn(),
    meeting: {
      updateMany: jest.fn(async () => ({ count: 1 })),
      findMany: jest.fn(async () => []),
    },
    recording: { updateMany: jest.fn(async () => ({ count: 1 })) },
    $disconnect: jest.fn(async () => undefined),
  },
}));

import prisma from "../../lib/prisma";
import { DELETE } from "../../app/api/organizations/[orgId]/route";
import { deleteRecordingObject } from "../../lib/stream/recording-storage";
import { deleteRecordingPreviewAssets } from "../../lib/supabase";
import { reportSentryError } from "../../lib/observability/report";

const txMock = {
  organization: {
    findUnique: jest.fn(),
    findUniqueOrThrow: jest.fn(),
    delete: jest.fn(async () => ({})),
  },
  payment: { count: jest.fn(async () => 0) },
  overageEvent: { count: jest.fn(async () => 0) },
  meeting: {
    findMany: jest.fn(
      async (): Promise<{ id: string; streamCallId: string }[]> => [],
    ),
    updateMany: jest.fn(async () => ({ count: 1 })),
  },
  recording: {
    findMany: jest.fn(
      async (): Promise<
        {
          id: string;
          storagePath: string | null;
          listingStatus: string;
        }[]
      > => [],
    ),
    updateMany: jest.fn(async () => ({ count: 1 })),
  },
};

const meetingUpdateMany = prisma.meeting.updateMany as jest.Mock;
const recordingUpdateMany = prisma.recording.updateMany as jest.Mock;

const req = {} as never;
const params = Promise.resolve({ orgId: "org-1" });

/** A money-untouched org whose history counts are all zero. */
function setUpHardDeleteShell() {
  txMock.organization.findUnique.mockResolvedValue(shellOrg);
  txMock.organization.findUniqueOrThrow.mockResolvedValue({
    _count: {
      contracts: 0,
      invoices: 0,
      purchaseOrders: 0,
      earnings: 0,
      payouts: 0,
    },
    billingAccountId: null,
  });
  txMock.meeting.findMany.mockResolvedValue([
    { id: "m-1", streamCallId: "call-1" },
  ]);
  txMock.recording.findMany.mockResolvedValue([
    {
      id: "r-1",
      storagePath: "recordings/r-1.mp4",
      listingStatus: "PUBLISHED",
    },
  ]);
}

beforeEach(() => {
  jest.clearAllMocks();
  (prisma.$transaction as jest.Mock).mockImplementation(
    async (fn: (t: typeof txMock) => Promise<unknown>) => fn(txMock),
  );
  meetingUpdateMany.mockResolvedValue({ count: 1 });
  recordingUpdateMany.mockResolvedValue({ count: 1 });
  txMock.organization.findUnique.mockResolvedValue(shellOrg);
  txMock.meeting.findMany.mockResolvedValue([]);
  txMock.recording.findMany.mockResolvedValue([]);
  endCall.mockResolvedValue(undefined);
  (deleteRecordingObject as jest.Mock).mockResolvedValue({ success: true });
  (deleteRecordingPreviewAssets as jest.Mock).mockResolvedValue(undefined);
  (reportSentryError as jest.Mock).mockReturnValue("");
});

describe("DELETE /api/organizations/[orgId] — hard delete does not orphan Stream", () => {
  it("marks every live call with the teardown marker INSIDE the transaction", async () => {
    setUpHardDeleteShell();

    const res = await DELETE(req, { params });

    expect(res.status).toBe(204);
    // The marker must be written by the transaction, not after it — after the
    // commit the org row is gone and there is nothing left to find these by.
    expect(txMock.meeting.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["m-1"] } },
      data: { endedReason: "org_deleted" },
    });
    expect(txMock.meeting.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
      txMock.organization.delete.mock.invocationCallOrder[0],
    );
  });

  it("unpublishes the org's recordings atomically with the org row", async () => {
    setUpHardDeleteShell();

    await DELETE(req, { params });

    expect(txMock.recording.updateMany).toHaveBeenCalledWith({
      where: {
        id: { in: ["r-1"] },
        listingStatus: { not: "UNPUBLISHED" },
      },
      data: { listingStatus: "UNPUBLISHED", publishedAt: null },
    });
  });

  it("makes no provider call inside the transaction", async () => {
    setUpHardDeleteShell();
    const order: string[] = [];
    txMock.meeting.updateMany.mockImplementation(async () => {
      order.push("tx:marker");
      return { count: 1 };
    });
    txMock.organization.delete.mockImplementation(async () => {
      order.push("tx:delete");
      return {};
    });
    endCall.mockImplementation(async () => {
      order.push("stream:end");
      return undefined;
    });

    await DELETE(req, { params });

    expect(order).toEqual(["tx:marker", "tx:delete", "stream:end"]);
  });

  it("ends the stranded calls and clears the marker once Stream confirms", async () => {
    setUpHardDeleteShell();

    await DELETE(req, { params });

    expect(endCall).toHaveBeenCalledTimes(1);
    expect(meetingUpdateMany).toHaveBeenCalledWith({
      where: { id: { in: ["m-1"] }, endedReason: "org_deleted" },
      data: { endedReason: null },
    });
  });

  it("leaves the marker standing when Stream will not end the call, so the job can retry", async () => {
    setUpHardDeleteShell();
    endCall.mockRejectedValue(new Error("Stream timeout"));

    const res = await DELETE(req, { params });

    // The org is gone; the DELETE must still succeed, and the marker is the
    // only handle the wind-down job has on those calls.
    expect(res.status).toBe(204);
    expect(meetingUpdateMany).not.toHaveBeenCalled();
    expect(reportSentryError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ op: "org.hard-delete.end-call" }),
    );
  });

  it("purges the stored bytes and tombstones the rows after the commit", async () => {
    setUpHardDeleteShell();

    await DELETE(req, { params });

    expect(deleteRecordingPreviewAssets).toHaveBeenCalledWith("r-1");
    expect(deleteRecordingObject).toHaveBeenCalledWith("recordings/r-1.mp4");
    expect(recordingUpdateMany).toHaveBeenCalledWith({
      where: { id: { in: ["r-1"] } },
      data: {
        status: "EXPIRED",
        storageUrl: null,
        storagePath: null,
        storageType: "STREAM_S3",
      },
    });
  });

  it("does not fail the DELETE when the recording bytes cannot be deleted", async () => {
    setUpHardDeleteShell();
    (deleteRecordingObject as jest.Mock).mockResolvedValue({
      success: false,
      error: "bucket unavailable",
    });

    const res = await DELETE(req, { params });

    expect(res.status).toBe(204);
    expect(recordingUpdateMany).not.toHaveBeenCalled();
    expect(reportSentryError).toHaveBeenCalled();
  });

  it("does no Stream work at all for the SOFT delete branch — DEACTIVATED is the queue", async () => {
    // Settled financial history forces the soft branch.
    txMock.organization.findUniqueOrThrow.mockResolvedValue({
      _count: {
        contracts: 1,
        invoices: 0,
        purchaseOrders: 0,
        earnings: 0,
        payouts: 0,
      },
      billingAccountId: null,
    });

    const res = await DELETE(req, { params });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ softDeleted: true });
    expect(txMock.meeting.findMany).not.toHaveBeenCalled();
    expect(txMock.meeting.updateMany).not.toHaveBeenCalled();
    expect(endCall).not.toHaveBeenCalled();
  });
});
