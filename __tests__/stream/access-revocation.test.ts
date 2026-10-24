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
  webinar: { findUnique: jest.fn(), findFirst: jest.fn() },
  class: { findUnique: jest.fn(), findFirst: jest.fn() },
  webinarPlan: { findUnique: jest.fn() },
  classPlan: { findUnique: jest.fn() },
  membership: { findFirst: jest.fn() },
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
jest.mock("../../lib/auth-helpers", () => ({
  isPrivileged: (role?: string | null) => role === "ADMIN" || role === "STAFF",
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

  it("queues the DM pair whose eligibility check throws and still checks the next pair", async () => {
    mockIsDmContextEligible
      .mockRejectedValueOnce(new Error("db timeout"))
      .mockResolvedValueOnce(false);
    const { revokeEndedBookingChatAccess } =
      await import("../../lib/stream/access-revocation");

    await revokeEndedBookingChatAccess({
      userIds: ["client-1"],
      dmCounterpartUserIds: ["host-1", "host-2"],
      dmOrganizationId: null,
    });

    expect(mockIsDmContextEligible).toHaveBeenCalledTimes(2);
    expect(mockRemoveMembers).toHaveBeenCalledTimes(1);
    expect(
      mockRevocationPrisma.streamRevocationRetry.createMany,
    ).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          kind: "DM_REMOVE",
          userId: "client-1",
          counterpartUserId: "host-1",
        }),
      ],
      skipDuplicates: true,
    });
  });
});

// An openable webinar whose live seats are attendee-keep and attendee-2.
const openableWebinar = ({ where }: { where: { id: string } }) =>
  Promise.resolve({
    webinarPlan: {
      organization: null,
      consultantProfile: { userId: "host-1", deletedAt: null },
      collaborators: [],
    },
    appointment: {
      deletedAt: null,
      organization: null,
      occurrences: [{ endsAt: new Date(Date.now() + 86_400_000) }],
      _count: { occurrences: 1 },
      participants: (where.id === "w1"
        ? ["attendee-keep", "attendee-2"]
        : []
      ).map((userId) => ({ userId })),
    },
  });

describe("event access predicate", () => {
  it("admits exactly the users the single-user check admits", async () => {
    mockRevocationPrisma.webinar.findFirst.mockImplementation(openableWebinar);
    const { eventParticipantsAmong, isEventParticipant } =
      await import("../../lib/stream/event-channel-service");
    const users = ["host-1", "attendee-keep", "stranger"];

    const batched = await eventParticipantsAmong("webinar", "w1", users);
    const single = await Promise.all(
      users.map((u) => isEventParticipant("webinar", "w1", u)),
    );

    expect(users.map((u) => batched?.has(u))).toEqual(single);
    expect(single).toEqual([true, true, false]);
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

  beforeEach(() => {
    mockRevocationPrisma.webinar.findFirst.mockImplementation(openableWebinar);
    mockRevocationPrisma.webinarPlan.findUnique.mockResolvedValue({
      organizationId: "org-1",
      organization: { status: "ACTIVE" },
      consultantProfile: { userId: "host-1" },
      collaborators: [{ consultantProfile: { userId: "collab-1" } }],
    });
    mockRevocationPrisma.membership.findFirst.mockImplementation(
      async ({ where }: { where: { userId: string } }) =>
        where.userId === "org-admin" ? { role: "MANAGER" } : null,
    );
  });

  it("removes only whom the access predicates refuse, keeps org admins, skips DMs, brakes and stops at the bound", async () => {
    mockRevocationQueryChannels.mockResolvedValueOnce([
      channel("webinar-w1", "2026-10-01T00:00:00Z", [
        "host-1",
        "attendee-keep",
        "attendee-2",
        "attendee-gone",
        "familiarise-support",
      ]),
      channel("webinar_legacy", "2026-10-02T00:00:00Z", ["anyone"]),
      channel("collab-webinar-plan-1", "2026-10-03T00:00:00Z", [
        "host-1",
        "collab-1",
        "org-admin",
        "stranger",
      ]),
      channel("dm-a-b", "2026-10-04T00:00:00Z", ["a", "b"]),
      channel("webinar-w2", "2026-10-05T00:00:00Z", ["host-1", "x", "y"]),
      channel("webinar-w3", "2026-10-06T00:00:00Z", ["host-1", "z"]),
      channel("webinar-w4", "2026-10-07T00:00:00Z", ["host-1", "q"]),
    ]);
    const { reconcileStreamMemberships } =
      await import("../../lib/stream/membership-reconciler");

    const result = await reconcileStreamMemberships({ limit: 4 });

    expect(mockRemoveMembers.mock.calls).toEqual([
      ["team", "webinar-w1", ["attendee-gone"]],
      ["team", "collab-webinar-plan-1", ["stranger"]],
      ["team", "webinar-w3", ["z"]],
    ]);
    expect(result).toMatchObject({
      channelsScanned: 4,
      channelsSkipped: 1,
      channelsSkippedSuspicious: 1,
      membersRemoved: 3,
      checkpoint: "2026-10-06T00:00:00Z",
    });
    expect(mockRevocationPrisma.user.findMany).toHaveBeenCalledTimes(4);
    expect(mockRevocationQueryChannels.mock.calls[0][0]).not.toHaveProperty(
      "created_at",
    );
    expect(mockReport).toHaveBeenCalledTimes(1);
  });

  it("leaves a cancelled or expired event's channel to the lifecycle jobs", async () => {
    mockRevocationPrisma.webinar.findFirst.mockResolvedValue(null);
    mockRevocationQueryChannels.mockResolvedValueOnce([
      channel("webinar-w9", "2026-10-01T00:00:00Z", ["host-1", "staff-1"]),
    ]);
    mockRevocationPrisma.user.findMany.mockResolvedValueOnce([
      { id: "host-1", role: "CONSULTANT" },
      { id: "staff-1", role: "STAFF" },
    ] as never);
    const { reconcileStreamMemberships } =
      await import("../../lib/stream/membership-reconciler");

    const result = await reconcileStreamMemberships();

    expect(mockRemoveMembers).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      channelsScanned: 1,
      channelsSkipped: 1,
      channelsSkippedSuspicious: 0,
      membersRemoved: 0,
    });
  });
});
