/**
 * @jest-environment node
 */

// A ban is permanent and a revoked verification removes what a collaborator
// needs, so each ends the account's invitations and team places as REMOVED in
// the action's own transaction. A suspension has an end date and ends none.

const mockStageNotices = jest.fn(async (..._args: unknown[]) => ({}));
const mockSendOwed = jest.fn(async (..._args: unknown[]) => undefined);
jest.mock("@/lib/collaborators/notifications", () => ({
  stageCollaboratorNotifications: (...args: unknown[]) =>
    mockStageNotices(...args),
  sendOwedCohostEmails: (...args: unknown[]) => mockSendOwed(...args),
}));
jest.mock("@sentry/nextjs", () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    moderationAction: { update: jest.fn(async () => ({})) },
    $executeRaw: jest.fn(),
  },
}));
jest.mock("../../lib/stream-client", () => ({
  __esModule: true,
  getStreamChatClient: jest.fn(() => ({
    revokeUserToken: jest.fn(async () => undefined),
    deactivateUser: jest.fn(async () => undefined),
  })),
  withStreamCircuitBreaker: jest.fn(async (op: () => Promise<unknown>) => op()),
  isExpectedStreamError: jest.fn(() => false),
}));
jest.mock("../../lib/novu", () => ({
  notifyModerationWarning: jest.fn(async () => ({ success: true })),
  notifyAccountSuspended: jest.fn(async () => ({ success: true })),
  notifyAccountBanned: jest.fn(async () => ({ success: true })),
  notifyVerificationStatusChanged: jest.fn(async () => ({ success: true })),
}));
// The email twins beside the bells; the prisma mock has no `user`.
jest.mock("../../lib/email", () => ({
  EMAIL_BUDGET_MS: { REQUEST: 5_000 },
  sendAccountSuspendedEmail: jest.fn(async () => ({
    sent: 1,
    skipped: 0,
    failed: 0,
  })),
  sendAccountBannedEmail: jest.fn(async () => ({
    sent: 1,
    skipped: 0,
    failed: 0,
  })),
}));
jest.mock("../../lib/moderation/cancel-user-engagements", () => ({
  __esModule: true,
  cancelFutureEngagementsForUser: jest.fn(async () => ({
    engagementsCancelled: 0,
    attendeeRemovals: 0,
    refundsIssued: 0,
    refundedPaise: 0,
    failures: [],
    refundedInFullOnUnreadableLedger: [],
    remaining: [],
  })),
}));
const mockPersist = jest.fn(async (..._args: unknown[]) => new Date());
const mockRevoke = jest.fn(async (..._args: unknown[]) => undefined);
jest.mock("../../lib/stream/access-revocation", () => ({
  persistCollaboratorRevocationInTx: (...args: unknown[]) =>
    mockPersist(...args),
  revokeCollaboratorAccess: (...args: unknown[]) => mockRevoke(...args),
}));

import prisma from "@/lib/prisma";
import {
  applyBestEffortEffects,
  applyTransactionalEffects,
} from "@/lib/moderation/side-effects";

type Row = {
  id: string;
  consultantProfileId: string;
  webinarPlanId: string | null;
  classPlanId: string | null;
  status: string;
  acceptedAt: Date | null;
  endedByUserId: string | null;
};
type Where = { id?: string; status: { in: string[] } };

let rows: Row[] = [];
const live = (where: Where) =>
  rows.filter(
    (r) =>
      where.status.in.includes(r.status) &&
      (where.id === undefined || r.id === where.id),
  );

const tx = {
  user: {
    update: jest.fn(async () => ({})),
    findUnique: jest.fn(async () => ({ consultantProfileId: "cp-1" })),
    findMany: jest.fn(async () => []),
  },
  $queryRaw: jest.fn(async () => [{ ready: false }]),
  session: {
    findMany: jest.fn(async () => []),
    deleteMany: jest.fn(async () => ({ count: 1 })),
  },
  consultantEarnings: {
    findMany: jest.fn(async () => []),
    updateMany: jest.fn(async () => ({ count: 0 })),
  },
  consultantProfile: {
    findUnique: jest.fn(async () => ({ userId: "u1" })),
    updateMany: jest.fn(async () => ({ count: 1 })),
    updateManyAndReturn: jest.fn(async () => [{ id: "cp-1" }]),
  },
  collaborator: {
    findMany: jest.fn(async ({ where }: { where: Where }) =>
      live(where).map(({ id }) => ({ id })),
    ),
    updateManyAndReturn: jest.fn(
      async ({ where, data }: { where: Where; data: Partial<Row> }) => {
        const hit = live(where);
        hit.forEach((r) => Object.assign(r, data));
        return hit;
      },
    ),
  },
};

const input = (
  actionType: "USER_BANNED" | "USER_SUSPENDED" | "PROFILE_UNVERIFIED",
) => ({
  actionType,
  report: {
    id: "r1",
    type: "PROFILE" as const,
    targetUserId: "u1",
    reviewId: null,
  },
  staffUserId: "admin-1",
});

beforeEach(() => {
  rows = [
    {
      id: "c-team",
      consultantProfileId: "cp-1",
      webinarPlanId: "wp-1",
      classPlanId: null,
      status: "ACCEPTED",
      acceptedAt: new Date("2027-01-01T00:00:00Z"),
      endedByUserId: null,
    },
    {
      id: "c-invited",
      consultantProfileId: "cp-1",
      webinarPlanId: null,
      classPlanId: "cp-9",
      status: "PENDING",
      acceptedAt: null,
      endedByUserId: null,
    },
  ];
});

describe("collaborations when an account loses its standing", () => {
  it.each(["USER_BANNED", "PROFILE_UNVERIFIED"] as const)(
    "%s ends the team place and the invitation as REMOVED by the staff member, then takes the team's access back",
    async (actionType) => {
      const transactional = await applyTransactionalEffects(
        tx as never,
        input(actionType),
      );

      expect(tx.collaborator.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            consultantProfile: { userId: "u1" },
            status: { in: ["PENDING", "ACCEPTED"] },
          },
        }),
      );
      expect(rows.map((r) => [r.status, r.endedByUserId])).toEqual([
        ["REMOVED", "admin-1"],
        ["REMOVED", "admin-1"],
      ]);
      // Only the plan whose team they were on holds access to take back.
      expect(mockPersist).toHaveBeenCalledTimes(1);
      expect(mockPersist).toHaveBeenCalledWith(
        tx,
        { planType: "webinar", planId: "wp-1" },
        "u1",
      );
      expect(transactional.collaborationsRemoved).toEqual([
        { planType: "webinar", planId: "wp-1" },
      ]);

      const summary = await applyBestEffortEffects(
        input(actionType),
        transactional,
      );

      expect(mockRevoke.mock.calls).toEqual([
        [{ planType: "webinar", planId: "wp-1" }, "u1"],
      ]);
      expect(summary.collaboratorRevocation).toBe("ok");
      expect(summary.errors).toBeUndefined();
    },
  );

  it("phase 2 stages the seat holders' emails of a banned co-presenter and keeps them out of the summary", async () => {
    const owed = { collaboratorId: "c-1", userIds: ["u-l1"] };
    mockStageNotices.mockResolvedValueOnce({ learnerEmails: owed });
    const transactional = await applyTransactionalEffects(
      tx as never,
      input("USER_BANNED"),
    );
    expect(mockSendOwed).not.toHaveBeenCalled();

    const summary = await applyBestEffortEffects(
      input("USER_BANNED"),
      transactional,
    );
    expect(mockSendOwed.mock.calls).toEqual([
      [[owed], "moderation.collaborationsRemoved"],
    ]);
    expect(summary).not.toHaveProperty("owedCohostEmails");
  });

  it("a time-limited suspension ends no collaboration", async () => {
    const transactional = await applyTransactionalEffects(
      tx as never,
      input("USER_SUSPENDED"),
    );

    expect(tx.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          banned: true,
          banExpires: expect.any(Date),
        }),
      }),
    );
    expect(tx.collaborator.findMany).not.toHaveBeenCalled();
    expect(tx.collaborator.updateManyAndReturn).not.toHaveBeenCalled();
    expect(rows.map((r) => r.status)).toEqual(["ACCEPTED", "PENDING"]);
    expect(transactional.collaborationsRemoved).toBeUndefined();

    await applyBestEffortEffects(input("USER_SUSPENDED"), transactional);
    expect(mockRevoke).not.toHaveBeenCalled();
  });

  it("still bans and ends sessions while the access-log table is missing", async () => {
    const transactional = await applyTransactionalEffects(
      tx as never,
      input("USER_BANNED"),
    );

    expect(tx.user.update).toHaveBeenCalled();
    expect(tx.session.deleteMany).toHaveBeenCalledWith({
      where: { userId: "u1" },
    });
    expect(transactional.sessionsRevoked).toBe(1);
    const summary = await applyBestEffortEffects(
      input("USER_BANNED"),
      transactional,
    );
    expect(summary).not.toHaveProperty("stagedSessionEnds");
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });
});
