/**
 * @jest-environment node
 */

// An erased expert leaves every team: the scrub ends their invitations and
// team places as REMOVED inside its transaction and takes Stream access back
// per plan after it, through the erasure's own outbox.

// Digital product erasure has its own suite; these scrubs own no products.
const mockStageNotices = jest.fn(async (..._args: unknown[]) => ({}));
const mockSendOwed = jest.fn(async (..._args: unknown[]) => undefined);
jest.mock("@/lib/collaborators/notifications", () => ({
  stageCollaboratorNotifications: (...args: unknown[]) =>
    mockStageNotices(...args),
  sendOwedCohostEmails: (...args: unknown[]) => mockSendOwed(...args),
}));
jest.mock("../../lib/compliance/erasure/mail-footprint", () => ({
  scrubMailFootprintTx: jest.fn(),
}));
jest.mock("../../lib/digital-products/erasure", () => ({
  scrubDigitalProductsTx: jest.fn(async () => []),
  purgeErasedCreatorFiles: jest.fn(async () => []),
}));
jest.mock("../../lib/enterprise/outbound-webhooks/dispatch", () => ({
  dispatchWebhookEvent: jest.fn(async () => undefined),
}));
jest.mock("../../lib/api/organizations/seat-count", () => ({
  releaseSeatsForTerminatedAssignments: jest.fn(async () => undefined),
}));
jest.mock("../../lib/observability/report", () => ({
  reportSentryError: jest.fn(),
}));
const mockLogDb = {
  $queryRaw: jest.fn(async () => [{ ready: true }]),
  $executeRaw: jest.fn(),
};
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  get default() {
    return mockLogDb;
  },
}));
const mockPersistRevocation = jest.fn();
jest.mock("../../lib/stream/access-revocation", () => ({
  persistCollaboratorRevocationInTx: (...args: unknown[]) =>
    mockPersistRevocation(...args),
  revokeCollaboratorAccess: jest.fn(),
}));
jest.mock("../../lib/stream/collaborator-access", () => ({
  driveCollaboratorRevocation: jest.fn(async () => null),
}));
jest.mock("../../lib/stream-client", () => ({
  isStreamConfigured: jest.fn(() => true),
  isExpectedStreamError: jest.fn(() => false),
  getStreamChatClient: jest.fn(() => ({
    revokeUserToken: jest.fn(async () => ({})),
    deleteUsers: jest.fn(async () => ({})),
  })),
}));

import { driveCollaboratorRevocation } from "@/lib/stream/collaborator-access";
import { scrubUser } from "@/lib/compliance/erasure/scrub-user";
import { supportScrubModels } from "../fixtures/support-erasure-models";

const tx = {
  ...supportScrubModels(),
  user: {
    update: jest.fn(async () => ({})),
    findUnique: jest.fn(async () => ({ consultantProfileId: "cp-1" })),
  },
  consultantProfile: {
    updateMany: jest.fn(async () => ({ count: 1 })),
    findUnique: jest.fn(async () => ({ userId: "u1" })),
  },
  // The consultee free-text scrub runs in the same tx.
  consulteeProfile: { updateMany: jest.fn(async () => ({ count: 0 })) },
  trial: { updateMany: jest.fn(async () => ({ count: 0 })) },
  consultation: { updateMany: jest.fn(async () => ({ count: 0 })) },
  collaborator: {
    findMany: jest.fn(async () => [{ id: "c-1" }]),
    updateManyAndReturn: jest.fn(async () => [
      {
        id: "c-1",
        consultantProfileId: "cp-1",
        webinarPlanId: "wp-1",
        classPlanId: null,
        status: "REMOVED",
        acceptedAt: new Date("2026-11-01T00:00:00Z"),
      },
    ]),
  },
  session: {
    findMany: jest.fn(async () => []),
    deleteMany: jest.fn(async () => ({ count: 0 })),
  },
  sessionAccessLog: { updateMany: jest.fn(async () => ({ count: 2 })) },
  $queryRaw: jest.fn(async () => [{ ready: true }]),
  account: { deleteMany: jest.fn(async () => ({ count: 0 })) },
  appointmentWaitlist: { deleteMany: jest.fn(async () => ({ count: 0 })) },
  windowBackupInterest: { deleteMany: jest.fn(async () => ({ count: 0 })) },
  referral: { updateMany: jest.fn(async () => ({ count: 1 })) },
  // The outbox: the request being processed and the rows the scrub writes
  // for it inside the transaction.
  erasureRequest: { findFirst: jest.fn(async () => ({ id: "er-1" })) },
  streamRevocationRetry: { createMany: jest.fn(async () => ({ count: 1 })) },
};
const db = {
  user: {
    findUnique: jest.fn(async () => ({
      id: "u1",
      erasedAt: null,
      pseudonymousId: null,
    })),
  },
  membership: { findMany: jest.fn(async () => []) },
  payoutAccount: { findMany: jest.fn(async () => []) },
  streamRevocationRetry: { update: jest.fn(async () => ({})) },
  $transaction: jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(tx)),
};

beforeEach(() => jest.clearAllMocks());

describe("DPDP erasure flips collaborator rows", () => {
  it("ends the user's PENDING and ACCEPTED rows as REMOVED in the transaction and revokes each plan after it", async () => {
    const result = await scrubUser(db as never, "u1");

    expect(result.scrubbed).toBe(true);
    expect(tx.collaborator.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          consultantProfile: { userId: "u1" },
          status: { in: ["PENDING", "ACCEPTED"] },
        },
      }),
    );
    // The platform ended it, so no person is named.
    expect(tx.collaborator.updateManyAndReturn).toHaveBeenCalledWith({
      where: { id: "c-1", status: { in: ["PENDING", "ACCEPTED"] } },
      data: { status: "REMOVED", endedByUserId: null },
    });
    // The erasure's own outbox row records the access to take back.
    expect(mockPersistRevocation).not.toHaveBeenCalled();
    expect(driveCollaboratorRevocation).toHaveBeenCalledWith(
      { planType: "webinar", planId: "wp-1" },
      "u1",
      Number.POSITIVE_INFINITY,
    );
  });

  it("stages the seat holders' emails of an erased co-presenter once the scrub has committed", async () => {
    const owed = { collaboratorId: "c-1", userIds: ["u-l1"] };
    mockStageNotices.mockResolvedValueOnce({ learnerEmails: owed });
    const committed = jest.fn();
    db.$transaction.mockImplementationOnce(async (fn) => {
      const result = await fn(tx);
      committed();
      return result;
    });
    await scrubUser(db as never, "u1");
    expect(mockSendOwed.mock.calls).toEqual([[[owed], "scrubUser"]]);
    expect(mockSendOwed.mock.invocationCallOrder[0]).toBeGreaterThan(
      committed.mock.invocationCallOrder[0],
    );
  });

  it("unlinks the CERT-In access log in the transaction and keeps its rows for the prune", async () => {
    await scrubUser(db as never, "u1");

    expect(tx.sessionAccessLog.updateMany).toHaveBeenCalledWith({
      where: { userId: "u1" },
      data: { userId: null },
    });
  });

  it("nulls the referred user's referral request signals and leaves the payer hashes", async () => {
    await scrubUser(db as never, "u1");

    expect(tx.referral.updateMany).toHaveBeenCalledWith({
      where: { referredUserId: "u1" },
      data: { ipHash: null, userAgent: null },
    });
  });

  it("stamps the access log after commit, and a throwing stamp leaves the erasure done", async () => {
    tx.session.findMany.mockResolvedValueOnce([
      {
        id: "s1",
        userId: "u1",
        ipAddress: "203.0.113.7",
        userAgent: "Firefox",
        createdAt: new Date("2026-11-01T00:00:00Z"),
        expiresAt: new Date("2099-01-01T00:00:00Z"),
      },
    ] as never);
    tx.session.deleteMany.mockResolvedValueOnce({ count: 1 });
    mockLogDb.$executeRaw.mockRejectedValueOnce(new Error("log table locked"));
    jest.spyOn(console, "error").mockImplementation(() => {});

    await expect(scrubUser(db as never, "u1")).resolves.toMatchObject({
      scrubbed: true,
    });
    expect(tx.session.deleteMany).toHaveBeenCalledWith({
      where: { userId: "u1" },
    });
    // Both notify-me tables: the account is scrubbed, so no cascade fires.
    for (const table of [tx.appointmentWaitlist, tx.windowBackupInterest]) {
      expect(table.deleteMany).toHaveBeenCalledWith({
        where: { userId: "u1" },
      });
    }
    expect(mockLogDb.$executeRaw).toHaveBeenCalledTimes(1);
    expect(mockLogDb.$executeRaw.mock.invocationCallOrder[0]).toBeGreaterThan(
      db.$transaction.mock.invocationCallOrder[0],
    );
    // The stamp drops the user link, as the in-transaction detach did.
    const { values, sql } = (
      mockLogDb.$executeRaw.mock.calls[0] as unknown as [
        unknown,
        { values: unknown[]; sql: string },
      ]
    )[1];
    expect(values).toContain("s1");
    expect(values).not.toContain("u1");
    expect(sql).not.toContain("users");
  });

  it("writes the outbox row inside the transaction and settles it after the attempt", async () => {
    // The revocation fails this time: the row was already durable before the
    // attempt, and is left FAILED with its first retry slot for the sweep.
    (driveCollaboratorRevocation as jest.Mock).mockResolvedValueOnce(
      "1 of 2 event channels not left",
    );

    await scrubUser(db as never, "u1");

    expect(tx.streamRevocationRetry.createMany).toHaveBeenCalledWith({
      data: [
        { erasureRequestId: "er-1", planType: "WEBINAR", planId: "wp-1" },
        {
          erasureRequestId: "er-1",
          planType: "WEBINAR",
          planId: "principal:u1",
        },
      ],
      skipDuplicates: true,
    });
    expect(db.streamRevocationRetry.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          erasureRequestId_planType_planId: {
            erasureRequestId: "er-1",
            planType: "WEBINAR",
            planId: "wp-1",
          },
        },
        data: expect.objectContaining({
          status: "FAILED",
          attempts: 1,
          nextRetryAt: expect.any(Date),
        }),
      }),
    );
  });
});
