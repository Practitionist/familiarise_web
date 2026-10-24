/**
 * @jest-environment node
 */

const mockRemoveMembers = jest.fn();
const mockRevocationQueryChannels = jest.fn();
const mockReport = jest.fn();
const mockIsDmContextEligible = jest.fn();

const mockRevocationPrisma = {
  streamRevocationRetry: {
    updateMany: jest.fn(async () => ({ count: 0 })),
    createMany: jest.fn(async () => ({ count: 1 })),
  },
  webinar: { findUnique: jest.fn() },
  class: { findUnique: jest.fn() },
  webinarPlan: { findUnique: jest.fn() },
  classPlan: { findUnique: jest.fn() },
  user: { findMany: jest.fn(async () => []) },
};

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: mockRevocationPrisma,
}));
jest.mock("../../lib/stream-client", () => ({
  getStreamChatClient: () => ({
    channel: (type: string, id: string) => ({
      removeMembers: (ids: string[]) => mockRemoveMembers(type, id, ids),
    }),
    queryChannels: (...args: unknown[]) => mockRevocationQueryChannels(...args),
  }),
  getStreamVideoClient: jest.fn(),
  withStreamCircuitBreaker: <T>(fn: () => Promise<T>) => fn(),
  StreamUnavailableError: class StreamUnavailableError extends Error {},
  isExpectedStreamError: () => false,
}));
jest.mock("../../actions/stream/chat/user.action", () => ({
  upsertUserToStream: jest.fn(),
  upsertUsersToStream: jest.fn(),
}));
jest.mock("../../lib/stream/dm-eligibility", () => ({
  isDmContextEligible: (...args: unknown[]) => mockIsDmContextEligible(...args),
  isDmChannelIdEligible: jest.fn(),
}));
jest.mock("../../lib/observability/report", () => ({
  reportSentryError: (...args: unknown[]) => mockReport(...args),
}));
jest.mock("../../lib/cron/with-cron-lock", () => ({
  withCronLock: (_name: string, _opts: unknown, fn: () => unknown) => fn(),
  readJobCheckpoint: jest.fn(async () => null),
}));

const webinarRoster = {
  appointment: {
    organizationId: null,
    participants: [{ userId: "attendee-keep" }],
  },
  webinarPlan: {
    organizationId: null,
    consultantProfile: { userId: "host-1", deletedAt: null },
    collaborators: [],
  },
};

beforeEach(() => {
  jest.clearAllMocks();
  mockRemoveMembers.mockResolvedValue({});
  mockIsDmContextEligible.mockResolvedValue(true);
  mockRevocationPrisma.webinar.findUnique.mockResolvedValue(webinarRoster);
});

describe("revocation on booking cancellation", () => {
  it("removes the attendee from the event channel and keeps a still-eligible DM", async () => {
    const { revokeEndedEventChatAccess } =
      await import("../../lib/stream/access-revocation");

    await revokeEndedEventChatAccess("webinar", "w1", ["attendee-1"]);

    expect(mockRemoveMembers).toHaveBeenCalledWith("team", "webinar-w1", [
      "attendee-1",
    ]);
    expect(mockIsDmContextEligible).toHaveBeenCalledWith(
      "host-1",
      "attendee-1",
      null,
    );
    expect(mockRemoveMembers).toHaveBeenCalledTimes(1);
    expect(
      mockRevocationPrisma.streamRevocationRetry.createMany,
    ).not.toHaveBeenCalled();
  });

  it("queues a durable retry when Stream refuses the removal", async () => {
    mockRemoveMembers.mockRejectedValue(new Error("Stream is down"));
    mockIsDmContextEligible.mockResolvedValue(false);
    const { revokeEndedEventChatAccess } =
      await import("../../lib/stream/access-revocation");

    await revokeEndedEventChatAccess("webinar", "w1", ["attendee-1"]);

    expect(
      mockRevocationPrisma.streamRevocationRetry.createMany,
    ).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        expect.objectContaining({
          kind: "EVENT_CHANNEL_REMOVE",
          userId: "attendee-1",
          planId: "w1",
          planType: "WEBINAR",
        }),
        expect.objectContaining({
          kind: "DM_REMOVE",
          userId: "attendee-1",
          counterpartUserId: "host-1",
        }),
      ]),
      skipDuplicates: true,
    });
  });
});

describe("daily membership reconciler", () => {
  const channel = (id: string, createdAt: string, members: string[]) => ({
    id,
    type: "team",
    data: { created_at: createdAt, member_count: members.length },
    state: { members: Object.fromEntries(members.map((m) => [m, {}])) },
    removeMembers: (ids: string[]) => mockRemoveMembers("team", id, ids),
  });

  it("removes members Postgres no longer seats, stops at the bound and checkpoints", async () => {
    mockRevocationQueryChannels.mockResolvedValueOnce([
      channel("webinar-w1", "2026-10-01T00:00:00Z", [
        "host-1",
        "attendee-keep",
        "attendee-gone",
        "familiarise-support",
      ]),
      channel("webinar_legacy", "2026-10-02T00:00:00Z", ["anyone"]),
      channel("webinar-w2", "2026-10-03T00:00:00Z", ["host-1", "stale"]),
      channel("webinar-w3", "2026-10-04T00:00:00Z", ["host-1", "stale"]),
    ]);
    const { reconcileStreamMemberships } =
      await import("../../lib/stream/membership-reconciler");

    const result = await reconcileStreamMemberships({ limit: 2 });

    expect(mockRemoveMembers).toHaveBeenCalledWith("team", "webinar-w1", [
      "attendee-gone",
    ]);
    expect(mockRemoveMembers).toHaveBeenCalledWith("team", "webinar-w2", [
      "stale",
    ]);
    expect(mockRemoveMembers).not.toHaveBeenCalledWith(
      "team",
      "webinar-w3",
      expect.anything(),
    );
    expect(result).toMatchObject({
      channelsScanned: 2,
      membersRemoved: 2,
      checkpoint: "2026-10-03T00:00:00Z",
    });
    expect(mockRevocationQueryChannels.mock.calls[0][0]).not.toHaveProperty(
      "created_at",
    );
    expect(mockReport).toHaveBeenCalledTimes(1);
  });
});
