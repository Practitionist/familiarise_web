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
}));
jest.mock("../../actions/stream/chat/event-channel.action", () => ({
  removeUserFromEventChannel: jest.fn(async () => ({ success: true })),
}));
jest.mock("../../lib/stream/event-channel-service", () => ({
  addUserToEventChannel: jest.fn(async () => ({ success: true })),
  checkEventChannelExists: jest.fn(async () => false),
  removeUserFromEventChannel: jest.fn(async () => ({ success: true })),
}));
jest.mock("../../lib/novu/service", () => ({
  notifyCollaboratorInvited: jest.fn(),
  notifyCollaboratorAccepted: jest.fn(),
  notifyCollaboratorRemoved: jest.fn(async () => undefined),
  notifyCollaboratorWithdrawn: jest.fn(async () => undefined),
}));
jest.mock("../../lib/email/senders/collaborators", () => ({
  sendCollaboratorInvitedEmail: jest.fn(async () => undefined),
  sendCollaboratorAcceptedEmail: jest.fn(async () => undefined),
  sendCollaboratorDeclinedEmail: jest.fn(async () => undefined),
  sendCollaboratorRemovedEmail: jest.fn(async () => undefined),
  sendCollaboratorWithdrawnEmail: jest.fn(async () => undefined),
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
  status: "ACCEPTED",
};
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    collaborator: {
      // Honour the ownership filter the withdraw path adds to the where.
      findFirst: jest.fn(
        async ({ where }: { where: Record<string, unknown> }) =>
          where.consultantProfileId === undefined ||
          where.consultantProfileId === row.consultantProfileId
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
  },
}));

import {
  notifyCollaboratorRemoved,
  notifyCollaboratorWithdrawn,
} from "@/lib/novu/service";
import prisma from "@/lib/prisma";
import { removeCollaborator } from "@/lib/collaborators/service";

describe("collaborator self-withdraw", () => {
  beforeEach(() => jest.clearAllMocks());

  it("lets the collaborator withdraw their own row and notifies the host", async () => {
    const result = await removeCollaborator("webinar", "c-1", "plan-1", {
      withdrawnByProfileId: "cp-collab",
    });
    expect(result).toMatchObject({ status: "REMOVED", accessRevoked: true });
    expect(notifyCollaboratorWithdrawn).toHaveBeenCalledWith(
      "u-host",
      expect.objectContaining({
        collaboratorName: "Collab",
        planType: "webinar",
      }),
    );
    expect(notifyCollaboratorRemoved).not.toHaveBeenCalled();
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

    const result = await removeCollaborator("webinar", "c-1", "plan-1", {
      withdrawnByProfileId: "cp-collab",
    });

    expect(result).toMatchObject({ accessRevoked: true });
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
    expect(notifyCollaboratorWithdrawn).not.toHaveBeenCalled();
  });

  it("a lost race (row already REMOVED) writes nothing and tells nobody", async () => {
    (prisma.collaborator.updateMany as jest.Mock).mockResolvedValueOnce({
      count: 0,
    });
    const result = await removeCollaborator("webinar", "c-1", "plan-1", {
      withdrawnByProfileId: row.consultantProfileId,
    });
    expect(result).toBeNull();
    expect(notifyCollaboratorWithdrawn).not.toHaveBeenCalled();
  });
});
