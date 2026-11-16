/**
 * @jest-environment node
 */

/**
 * A ban ends the user's collaborations in the action's transaction and hands
 * the teams they were on to phase 2, which revokes their Stream access. A
 * pending invitation held no access, so it is ended but not revoked.
 */
jest.mock("@/lib/collaborators/notifications", () => ({
  stageCollaboratorNotifications: jest.fn(async () => ({})),
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
// #1653 — the email twins beside the bells; the prisma mock has no `user`.
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
const mockRevoke = jest.fn(async (..._args: unknown[]) => undefined);
jest.mock("../../lib/stream/access-revocation", () => ({
  revokeCollaboratorAccess: (...args: unknown[]) => mockRevoke(...args),
}));
const webinarTeam = { planType: "webinar", planId: "wp-1" };
const classTeam = { planType: "class", planId: "cp-9" };
const mockEndCollaborations = jest.fn(async (..._args: unknown[]) => [
  { ref: webinarTeam, wasOnTeam: true },
  { ref: classTeam, wasOnTeam: true },
  { ref: { planType: "class", planId: "cp-invited" }, wasOnTeam: false },
]);
jest.mock("../../lib/collaborators/ending", () => ({
  endCollaborationsForUser: (...args: unknown[]) =>
    mockEndCollaborations(...args),
}));

import prisma from "@/lib/prisma";
import {
  applyBestEffortEffects,
  applyTransactionalEffects,
} from "@/lib/moderation/side-effects";

const tx = {
  user: {
    update: jest.fn(async () => ({})),
    findUnique: jest.fn(async () => ({ consultantProfileId: "cp-1" })),
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
};

const input = {
  actionType: "USER_BANNED" as const,
  report: {
    id: "r1",
    type: "PROFILE" as const,
    targetUserId: "u1",
    reviewId: null,
  },
  staffUserId: "admin-1",
};

describe("a ban revokes collaborator standing", () => {
  it("ends the collaborations in phase 1 and revokes each team in phase 2", async () => {
    const transactional = await applyTransactionalEffects(tx as never, input);

    expect(mockEndCollaborations).toHaveBeenCalledWith(tx, "u1", {
      endedByUserId: "admin-1",
    });
    expect(transactional.collaborationsRemoved).toEqual([
      webinarTeam,
      classTeam,
    ]);

    const summary = await applyBestEffortEffects(input, transactional);

    expect(mockRevoke.mock.calls).toEqual([
      [webinarTeam, "u1"],
      [classTeam, "u1"],
    ]);
    expect(summary.collaboratorRevocation).toBe("ok");
    expect(summary.errors).toBeUndefined();
  });

  it("still bans and ends sessions while the access-log table is missing", async () => {
    const transactional = await applyTransactionalEffects(tx as never, input);

    expect(tx.user.update).toHaveBeenCalled();
    expect(tx.session.deleteMany).toHaveBeenCalledWith({
      where: { userId: "u1" },
    });
    expect(transactional.sessionsRevoked).toBe(1);
    const summary = await applyBestEffortEffects(input, transactional);
    expect(summary).not.toHaveProperty("stagedSessionEnds");
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });
});
