/**
 * @jest-environment node
 */

/**
 * #1580 C-P0-4 — a banned collaborator used to stay ACCEPTED: still in every
 * future split, on rosters and recordings, and on the public co-host list.
 * Phase 1 now moves their PENDING/ACCEPTED rows to REMOVED and hands the
 * affected plans to phase 2, which runs the same Stream revocation
 * `removeCollaborator` runs. Reinstatement does not restore the rows.
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
jest.mock("../../lib/stream/collaborator-access", () => ({
  driveCollaboratorRevocation: jest.fn(async () => null),
}));

import prisma from "@/lib/prisma";
import { driveCollaboratorRevocation } from "@/lib/stream/collaborator-access";
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
  collaborator: {
    // One statement flips and returns the rows, so the revocation list is
    // exactly what was flipped.
    updateManyAndReturn: jest.fn(async () => [
      { collaboratorType: "WEBINAR", webinarPlanId: "wp-1", classPlanId: null },
      { collaboratorType: "CLASS", webinarPlanId: null, classPlanId: "cp-9" },
    ]),
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
  it("flips both rows to REMOVED in phase 1 and revokes both plans in phase 2", async () => {
    const transactional = await applyTransactionalEffects(tx as never, input);

    expect(tx.collaborator.updateManyAndReturn).toHaveBeenCalledWith({
      where: {
        consultantProfileId: "cp-1",
        status: { in: ["PENDING", "ACCEPTED"] },
      },
      data: { status: "REMOVED", respondedAt: expect.any(Date) },
    });
    expect(transactional.collaborationsRemoved).toEqual([
      { planType: "webinar", planId: "wp-1" },
      { planType: "class", planId: "cp-9" },
    ]);

    const summary = await applyBestEffortEffects(input, transactional);

    expect(driveCollaboratorRevocation).toHaveBeenCalledTimes(2);
    expect(driveCollaboratorRevocation).toHaveBeenCalledWith(
      { planType: "webinar", planId: "wp-1" },
      "u1",
      Number.POSITIVE_INFINITY,
    );
    expect(driveCollaboratorRevocation).toHaveBeenCalledWith(
      { planType: "class", planId: "cp-9" },
      "u1",
      Number.POSITIVE_INFINITY,
    );
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

  it("records a failed revocation per plan without blocking the other steps", async () => {
    (driveCollaboratorRevocation as jest.Mock).mockResolvedValueOnce(
      "1 of 2 event channels not left",
    );
    const summary = await applyBestEffortEffects(input, {
      collaborationsRemoved: [
        { planType: "webinar", planId: "wp-1" },
        { planType: "class", planId: "cp-9" },
      ],
    });
    expect(summary.collaboratorRevocation).toBe("failed");
    expect(summary.errors).toEqual(["collaborator-revoke: webinar:wp-1"]);
    expect(summary.stream).toBe("ok");
  });
});
