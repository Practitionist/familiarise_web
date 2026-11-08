/**
 * @jest-environment node
 */

jest.mock("server-only", () => ({}));
jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));
jest.mock("../../lib/observability/report", () => ({
  reportSentryError: jest.fn(),
}));
jest.mock("../../lib/cron/with-cron-lock", () => ({
  withCronLock: jest.fn(
    async (_name: string, _opts: unknown, fn: () => Promise<unknown>) => fn(),
  ),
}));

const mockUpdateCallMembers = jest.fn(async () => ({}));
const mockUpdateUserPermissions = jest.fn(async () => ({}));
const mockKickUser = jest.fn(async () => ({}));
const mockRemoveChannelMembers = jest.fn(async () => undefined);

jest.mock("../../lib/stream-client", () => ({
  getStreamChatClient: jest.fn(() => ({
    channel: () => ({ removeMembers: mockRemoveChannelMembers }),
  })),
  getStreamVideoClient: jest.fn(() => ({
    video: {
      call: () => ({
        updateCallMembers: mockUpdateCallMembers,
        updateUserPermissions: mockUpdateUserPermissions,
        kickUser: mockKickUser,
      }),
    },
  })),
  isExpectedStreamError: () => false,
}));

jest.mock("../../lib/stream/event-channel-service", () => ({
  addUserToEventChannel: jest.fn(async () => ({ success: true })),
  checkEventChannelExists: jest.fn(async () => false),
  removeUserFromEventChannel: jest.fn(async () => ({ success: true })),
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

const mockMemberFindFirst = jest.fn();

jest.mock("../../lib/prisma", () => {
  const db: Record<string, unknown> = {
    $transaction: jest.fn(async (run: (tx: unknown) => unknown) => run(db)),
    webinarPlan: { findUnique: jest.fn(), findMany: jest.fn() },
    classPlan: { findUnique: jest.fn(), findMany: jest.fn() },
    consultationPlan: { findMany: jest.fn() },
    subscriptionPlan: { findMany: jest.fn() },
    consultantProfile: { findFirst: jest.fn(), findUnique: jest.fn() },
    membership: { findFirst: (args: unknown) => mockMemberFindFirst(args) },
    collaborator: {
      findMany: jest.fn(),
      updateMany: jest.fn(),
      findUniqueOrThrow: jest.fn(),
    },
    webinar: { findMany: jest.fn() },
    class: { findMany: jest.fn() },
    consultation: { groupBy: jest.fn() },
    subscription: { groupBy: jest.fn() },
    appointmentParticipant: {
      findMany: jest.fn(),
      updateMany: jest.fn(),
    },
    appointmentOccurrence: { findMany: jest.fn() },
    consultantEarnings: { groupBy: jest.fn(), findMany: jest.fn() },
    organizationEarnings: { groupBy: jest.fn(), findMany: jest.fn() },
    appointmentWaitlist: { groupBy: jest.fn(async () => []) },
    appointment: { findMany: jest.fn(async () => []) },
  };
  return { __esModule: true, default: db };
});

import prisma from "@/lib/prisma";
import {
  getCollaboratorsForUser,
  revokeCollaboratorAccess,
} from "@/lib/collaborators/service";
import { expireStaleCollaboratorInvites } from "@/lib/collaborators/cleanup";
import { readOfferingStats } from "@/lib/data/offering-stats";

describe("collaborator security, seat counting, SFU revocation, and lifecycle sweeps", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("null-owner plan authorization guard (null !== null)", () => {
    it("rejects non-consultant non-org-admin caller when plan.consultantProfileId is null", async () => {
      (prisma.webinarPlan.findUnique as jest.Mock).mockResolvedValueOnce({
        consultantProfileId: null,
        organizationId: "org-1",
      });
      (prisma.consultantProfile.findFirst as jest.Mock).mockResolvedValueOnce(
        null,
      );
      mockMemberFindFirst.mockResolvedValueOnce(null);

      const res = await getCollaboratorsForUser(
        "webinar",
        "plan-org-1",
        "stranger-user-id",
      );

      expect(res).toEqual({ status: "forbidden" });
      expect(prisma.collaborator.findMany).not.toHaveBeenCalled();
    });

    it("rejects org member lacking catalog.manage permission on null-owner org plan", async () => {
      (prisma.webinarPlan.findUnique as jest.Mock).mockResolvedValueOnce({
        consultantProfileId: null,
        organizationId: "org-1",
      });
      (prisma.consultantProfile.findFirst as jest.Mock).mockResolvedValueOnce(
        null,
      );
      mockMemberFindFirst.mockResolvedValueOnce({
        role: "LEARNER",
        organization: { status: "ACTIVE" },
      });

      const res = await getCollaboratorsForUser(
        "webinar",
        "plan-org-1",
        "member-user-id",
      );

      expect(res).toEqual({ status: "forbidden" });
      expect(prisma.collaborator.findMany).not.toHaveBeenCalled();
    });

    it("grants access to authorized active org admin holding catalog.manage on null-owner plan", async () => {
      (prisma.webinarPlan.findUnique as jest.Mock).mockResolvedValueOnce({
        consultantProfileId: null,
        organizationId: "org-1",
      });
      (prisma.consultantProfile.findFirst as jest.Mock).mockResolvedValueOnce(
        null,
      );
      mockMemberFindFirst.mockResolvedValueOnce({
        role: "OWNER",
        organization: { status: "ACTIVE" },
      });
      (prisma.collaborator.findMany as jest.Mock).mockResolvedValueOnce([
        {
          id: "collab-1",
          consultantProfileId: "cp-1",
          status: "ACCEPTED",
          role: "CO_HOST",
          revenueShareBps: 2500,
          consultantProfile: { user: { name: "Co-Host", image: null } },
        },
      ]);

      const res = await getCollaboratorsForUser(
        "webinar",
        "plan-org-1",
        "org-admin-user",
      );

      expect(res).toMatchObject({
        status: "ok",
        data: [expect.objectContaining({ id: "collab-1" })],
      });
    });
  });

  describe("learner seat count exclusion (role: CONSULTEE vs COLLABORATOR)", () => {
    it("filters appointment participant counts strictly to role CONSULTEE", async () => {
      (prisma.consultationPlan.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.subscriptionPlan.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.webinarPlan.findMany as jest.Mock)
        .mockResolvedValueOnce([
          {
            id: "wp-1",
            title: "Architecture Deep Dive",
            consultantProfileId: "cp-host",
            organizationId: null,
            archivedAt: null,
            collaborators: [],
          },
        ])
        .mockResolvedValueOnce([]);
      (prisma.classPlan.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.webinar.findMany as jest.Mock).mockResolvedValueOnce([
        {
          id: "w-1",
          webinarPlanId: "wp-1",
          appointment: { _count: { participants: 3 } },
        },
      ]);
      (prisma.consultantEarnings.groupBy as jest.Mock).mockResolvedValueOnce(
        [],
      );
      (prisma.organizationEarnings.groupBy as jest.Mock).mockResolvedValueOnce(
        [],
      );

      (prisma.appointmentWaitlist.groupBy as jest.Mock).mockResolvedValueOnce([
        {
          planKind: "WEBINAR",
          planId: "wp-1",
          appointmentId: "appt-1",
          _count: { _all: 4 },
        },
      ]);
      (prisma.appointment.findMany as jest.Mock).mockResolvedValueOnce([
        { id: "appt-1", webinarId: "w-1", classId: null },
      ]);

      const stats = await readOfferingStats("cp-host");

      expect(prisma.webinar.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          select: expect.objectContaining({
            appointment: {
              select: {
                _count: {
                  select: {
                    participants: {
                      where: expect.objectContaining({ role: "CONSULTEE" }),
                    },
                  },
                },
              },
            },
          }),
        }),
      );
      expect(stats.rows).toContainEqual(
        expect.objectContaining({
          planId: "wp-1",
          bookings: 3,
          waitingCount: 4,
        }),
      );
      expect(stats.waitingByEvent).toEqual({ "w-1": 4 });
    });
  });

  describe("live SFU revocation (updateUserPermissions + kickUser)", () => {
    it("revokes live track permissions and kicks unseated collaborator from open SFU rooms", async () => {
      (prisma.webinarPlan.findUnique as jest.Mock).mockResolvedValueOnce({
        title: "System Design Live",
      });
      (
        prisma.appointmentParticipant.updateMany as jest.Mock
      ).mockResolvedValueOnce({ count: 1 });
      (prisma.webinar.findMany as jest.Mock).mockResolvedValueOnce([
        { id: "w-live" },
      ]);
      (
        prisma.appointmentOccurrence.findMany as jest.Mock
      ).mockResolvedValueOnce([
        {
          appointmentId: "appt-live",
          meeting: { streamCallId: "occurrence-occ-live" },
        },
      ]);
      (
        prisma.appointmentParticipant.findMany as jest.Mock
      ).mockResolvedValueOnce([]);

      const result = await revokeCollaboratorAccess(
        "webinar",
        "wp-live",
        "user-collab-removed",
      );

      expect(result).toEqual({ success: true });
      expect(mockUpdateCallMembers).toHaveBeenCalledWith({
        remove_members: ["user-collab-removed"],
      });
      expect(mockUpdateUserPermissions).toHaveBeenCalledWith({
        user_id: "user-collab-removed",
        revoke_permissions: ["send-audio", "send-video", "screenshare"],
      });
      expect(mockKickUser).toHaveBeenCalledWith({
        user_id: "user-collab-removed",
      });
    });
  });

  describe("14-day pending invitation expiration sweep", () => {
    it("expires stale PENDING rows via conditional CAS updateMany and stages one bell and two emails per expiry", async () => {
      (prisma.collaborator.findMany as jest.Mock).mockResolvedValueOnce([
        { id: "collab-stale-1" },
        { id: "collab-raced-2" },
      ]);
      (prisma.collaborator.updateMany as jest.Mock)
        .mockResolvedValueOnce({ count: 1 })
        .mockResolvedValueOnce({ count: 0 });
      (prisma.collaborator.findUniqueOrThrow as jest.Mock).mockResolvedValue({
        id: "collab-stale-1",
        consultantProfileId: "cp-invitee",
        webinarPlanId: "wp-1",
        classPlanId: null,
        invitedById: "cp-host",
        role: "CO_HOST",
        revenueShareBps: 2500,
        updatedAt: new Date("2026-11-07T00:00:00Z"),
      });
      (prisma.webinarPlan.findUnique as jest.Mock).mockResolvedValue({
        title: "Distributed Systems Workshop",
        consultantProfile: { userId: "u-host", user: { name: "Host" } },
      });
      (prisma.consultantProfile.findUnique as jest.Mock).mockImplementation(
        async ({ where }: { where: { id: string } }) =>
          where.id === "cp-invitee"
            ? { userId: "u-invitee", user: { name: "Invitee" } }
            : { userId: "u-host", user: { name: "Host" } },
      );

      const summary = await expireStaleCollaboratorInvites(100);

      expect(summary).toEqual({ expired: 1, scanned: 2 });
      expect(prisma.collaborator.updateMany).toHaveBeenNthCalledWith(1, {
        where: {
          id: "collab-stale-1",
          status: "PENDING",
          updatedAt: { lt: expect.any(Date) },
        },
        data: { status: "DECLINED", respondedAt: expect.any(Date) },
      });
      expect(mockStageBell).toHaveBeenCalledTimes(1);
      expect(mockStageBell).toHaveBeenCalledWith(
        prisma,
        expect.objectContaining({
          workflowId: "collaborator-invite-expired",
          recipients: ["u-invitee", "u-host"],
        }),
      );
      expect(
        mockStageEmail.mock.calls.map(
          ([, args]) => (args as { recipientUserId: string }).recipientUserId,
        ),
      ).toEqual(["u-invitee", "u-host"]);
    });
  });
});
