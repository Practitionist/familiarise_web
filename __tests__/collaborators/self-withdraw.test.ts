/**
 * @jest-environment node
 */

/**
 * #1580 C-P1-7 — a collaborator may withdraw their own PENDING/ACCEPTED row
 * through the same REMOVED path the owner uses; the notice then goes to the
 * host, not to them. A third party's withdraw attempt matches no row.
 */

jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));
jest.mock("../../lib/observability/report", () => ({
  reportSentryError: jest.fn(),
}));
const mockUpdateCallMembers = jest.fn(async () => ({}));
jest.mock("../../lib/stream-client", () => ({
  getStreamChatClient: jest.fn(() => ({
    channel: () => ({ removeMembers: jest.fn(async () => undefined) }),
  })),
  getStreamVideoClient: jest.fn(() => ({
    video: {
      call: () => ({
        updateCallMembers: mockUpdateCallMembers,
        updateUserPermissions: jest.fn(async () => ({})),
        kickUser: jest.fn(async () => ({})),
      }),
    },
  })),
  isExpectedStreamError: () => false,
  isStreamConfigured: () => true,
}));
jest.mock("../../actions/stream/chat/event-channel.action", () => ({
  removeUserFromEventChannel: jest.fn(async () => ({ success: true })),
}));
jest.mock("../../lib/stream/event-channel-service", () => ({
  addUserToEventChannel: jest.fn(async () => ({ success: true })),
  checkEventChannelExists: jest.fn(async () => false),
  removeUsersFromEventChannel: jest.fn(async () => ({ failedUserIds: [] })),
}));
const mockStageBell = jest.fn(async (..._args: unknown[]) => null);
const mockStageEmail = jest.fn(async (..._args: unknown[]) => []);
jest.mock("../../lib/novu/stage-bell", () => ({
  stageBell: (...args: unknown[]) => mockStageBell(...args),
}));
jest.mock("../../lib/email/senders/collaborators", () => ({
  stageCollaboratorLifecycleEmail: (...args: unknown[]) =>
    mockStageEmail(...args),
}));
jest.mock(
  "../../utils/organization-roles",
  () => ({ hasOrgPermission: jest.fn(() => false) }),
  { virtual: true },
);

const row = {
  id: "c-1",
  consultantProfileId: "cp-collab",
  webinarPlanId: "plan-1",
  classPlanId: null,
  invitedById: null,
  role: "CO_HOST",
  revenueShareBps: 2000,
  updatedAt: new Date("2026-11-07T00:00:00Z"),
  status: "ACCEPTED",
};
jest.mock("../../lib/prisma", () => {
  const db: Record<string, unknown> = {
    $transaction: jest.fn(async (run: (tx: unknown) => unknown) => run(db)),
    collaborator: {
      // Honour the ownership filter the withdraw path adds to the where.
      // The revoke's own re-read asks for an ACCEPTED row, and finds none.
      findFirst: jest.fn(
        async ({ where }: { where: Record<string, unknown> }) =>
          where.status !== "ACCEPTED" &&
          (where.consultantProfileId === undefined ||
            where.consultantProfileId === row.consultantProfileId)
            ? row
            : null,
      ),
      // The removal is a CAS `updateMany` on PENDING/ACCEPTED, then a re-read (#1580).
      updateMany: jest.fn(async () => ({ count: 1 })),
      findUniqueOrThrow: jest.fn(async () => ({ ...row, status: "REMOVED" })),
    },
    consultantProfile: {
      findUnique: jest.fn(async () => ({
        userId: "u-collab",
        user: { name: "Collab" },
      })),
    },
    webinarPlan: {
      findUnique: jest.fn(async () => ({
        title: "T",
        consultantProfile: { userId: "u-host" },
      })),
    },
    webinar: { findMany: jest.fn(async () => []) },
    // #1580 — the shadow participant rows are cancelled with the standing.
    appointmentParticipant: {
      updateMany: jest.fn(async () => ({ count: 1 })),
      findMany: jest.fn(async () => []),
    },
    appointmentOccurrence: { findMany: jest.fn(async () => []) },
    streamRevocationRetry: {
      updateMany: jest.fn(async () => ({ count: 0 })),
      createMany: jest.fn(async () => ({ count: 1 })),
    },
  };
  return { __esModule: true, default: db };
});

import prisma from "@/lib/prisma";
import { removeCollaborator } from "@/lib/collaborators/service";

describe("collaborator self-withdraw", () => {
  beforeEach(() => jest.clearAllMocks());

  it("lets the collaborator withdraw their own row and notifies the host", async () => {
    const result = await removeCollaborator("webinar", "c-1", "plan-1", {
      withdrawnByProfileId: "cp-collab",
    });
    expect(result).toMatchObject({ status: "REMOVED" });
    // The revoke is owed durably even though every Stream call succeeded.
    expect(prisma.streamRevocationRetry.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [
          expect.objectContaining({
            kind: "COLLAB_REVOKE",
            userId: "u-collab",
            planId: "plan-1",
          }),
        ],
      }),
    );
    // One WITHDRAWN notice to the host, staged in the removal's transaction.
    expect(mockStageBell).toHaveBeenCalledTimes(1);
    expect(mockStageBell).toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({
        workflowId: "collaborator-withdrawn",
        recipients: ["u-host"],
        payload: expect.objectContaining({
          collaboratorName: "Collab",
          planType: "webinar",
        }),
      }),
    );
    expect(mockStageEmail).toHaveBeenCalledTimes(1);
    expect(mockStageEmail).toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({
        event: "WITHDRAWN",
        recipientUserId: "u-host",
      }),
    );
    expect(prisma.appointmentParticipant.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        // #1846 SM-B9 — the caller's scope is the first AND arm.
        where: {
          AND: expect.arrayContaining([
            expect.objectContaining({
              userId: "u-collab",
              role: "COLLABORATOR",
            }),
          ]),
        },
        data: { status: "CANCELLED" },
      }),
    );
  });

  it("downgrades a seated collaborator to call_member on the plan's open calls", async () => {
    (prisma.appointmentOccurrence.findMany as jest.Mock).mockResolvedValueOnce([
      { appointmentId: "appt-1", meeting: { streamCallId: "occurrence-o1" } },
    ]);
    (prisma.appointmentParticipant.findMany as jest.Mock).mockResolvedValueOnce(
      [{ appointmentId: "appt-1" }],
    );

    await removeCollaborator("webinar", "c-1", "plan-1", {
      withdrawnByProfileId: "cp-collab",
    });

    expect(mockUpdateCallMembers).toHaveBeenCalledWith({
      update_members: [{ user_id: "u-collab", role: "call_member" }],
    });
  });

  it("matches no row for a third party", async () => {
    const result = await removeCollaborator("webinar", "c-1", "plan-1", {
      withdrawnByProfileId: "cp-stranger",
    });
    expect(result).toBeNull();
    expect(prisma.collaborator.updateMany).not.toHaveBeenCalled();
    expect(mockStageBell).not.toHaveBeenCalled();
  });

  it("a lost race (row already REMOVED) writes nothing and tells nobody", async () => {
    (prisma.collaborator.updateMany as jest.Mock).mockResolvedValueOnce({
      count: 0,
    });
    const result = await removeCollaborator("webinar", "c-1", "plan-1", {
      withdrawnByProfileId: row.consultantProfileId,
    });
    expect(result).toBeNull();
    expect(mockStageBell).not.toHaveBeenCalled();
  });
});
