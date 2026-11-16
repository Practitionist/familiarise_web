/**
 * @jest-environment node
 */

jest.mock("server-only", () => ({}));
jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));
jest.mock("../../lib/observability/report", () => ({
  reportSentryError: jest.fn(),
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
  removeUsersFromEventChannel: jest.fn(async () => ({ failedUserIds: [] })),
}));

jest.mock("../../lib/prisma", () => {
  const db: Record<string, unknown> = {
    $transaction: jest.fn(async (run: (tx: unknown) => unknown) => run(db)),
    webinarPlan: { findUnique: jest.fn(), findMany: jest.fn() },
    classPlan: { findUnique: jest.fn(), findMany: jest.fn() },
    consultationPlan: { findMany: jest.fn() },
    subscriptionPlan: { findMany: jest.fn() },
    consultantProfile: { findFirst: jest.fn(), findUnique: jest.fn() },
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
import { driveCollaboratorRevocation } from "@/lib/stream/collaborator-access";
import { readOfferingStats } from "@/lib/data/offering-stats";

describe("learner seat counts and live-room revocation", () => {
  beforeEach(() => {
    jest.clearAllMocks();
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

      const owed = await driveCollaboratorRevocation(
        { planType: "webinar", planId: "wp-live" },
        "user-collab-removed",
        Number.POSITIVE_INFINITY,
      );

      expect(owed).toBeNull();
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
});
