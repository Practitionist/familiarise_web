/**
 * @jest-environment node
 */

/**
 * Accepting gives the collaborator each existing event chat through the real
 * membership write; adds that fail are collected and reported once.
 */

const mockAddMembers = jest.fn();
const mockCapture = jest.fn();
const mockReport = jest.fn();

jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: {
    webinarPlan: { findUnique: async () => ({ organizationId: null }) },
    webinar: {
      findMany: async () => [{ id: "w-1" }, { id: "w-2" }, { id: "w-3" }],
    },
    collaborator: { findFirst: async () => null },
    appointment: { findUnique: async () => null },
  },
}));

jest.mock("@/lib/stream-client", () => {
  class StreamUnavailableError extends Error {}
  return {
    StreamUnavailableError,
    getStreamChatClient: () => ({
      // Every event chat exists.
      queryChannels: async () => [{}],
      channel: (_type: string, id: string) => ({
        addMembers: async () => mockAddMembers(id),
      }),
    }),
    withStreamCircuitBreaker: (fn: () => unknown) => fn(),
    isExpectedStreamError: () => false,
  };
});

jest.mock("@/lib/stream-cache", () => ({
  isChannelCached: () => undefined,
  markChannelExists: () => undefined,
  getMembershipCached: () => undefined,
  markMembership: () => undefined,
}));

jest.mock("@/actions/stream/chat/user.action", () => ({
  upsertUserToStream: async () => ({}),
  upsertUsersToStream: async () => ({ droppedIds: [] }),
}));

jest.mock("@/actions/stream/chat/channel.action", () => ({
  createCollaboratorChannel: async () => undefined,
}));

jest.mock("@/lib/stream/access-revocation", () => ({
  fenceCollaboratorGrant: async () => ({ verified: true, lost: false }),
  fenceSeatGrants: async () => undefined,
}));

jest.mock("@sentry/nextjs", () => ({
  captureException: (...args: unknown[]) => mockCapture(...args),
}));
jest.mock("@/lib/observability/report", () => ({
  reportSentryError: (...args: unknown[]) => mockReport(...args),
}));

import { StreamUnavailableError } from "@/lib/stream-client";
import { grantCollaboratorAccess } from "@/lib/stream/collaborator-access";

describe("granting a collaborator the plan's event chats", () => {
  it("attempts every event and reports the failed adds once, tagged collaborators, with a sample of event ids", async () => {
    mockAddMembers.mockImplementation(async (channelId: string) => {
      if (channelId !== "webinar-w-2") throw new StreamUnavailableError();
      return {};
    });

    await grantCollaboratorAccess(
      { planType: "webinar", planId: "plan-1" },
      "u-1",
    );

    expect(mockAddMembers.mock.calls).toEqual([
      ["webinar-w-1"],
      ["webinar-w-2"],
      ["webinar-w-3"],
    ]);
    expect(mockCapture).not.toHaveBeenCalled();
    expect(mockReport.mock.calls).toEqual([
      [
        expect.any(StreamUnavailableError),
        expect.objectContaining({
          subsystem: "collaborators",
          op: "grantCollaboratorAccess",
          extra: expect.objectContaining({
            eventAddsFailed: 2,
            eventIds: ["w-1", "w-3"],
          }),
        }),
      ],
    ]);
  });
});
