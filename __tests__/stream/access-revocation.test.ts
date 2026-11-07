/**
 * @jest-environment node
 */

const mockRemoveMembers = jest.fn();
const mockRevocationQueryChannels = jest.fn();
const mockReport = jest.fn();
const mockIsDmContextEligible = jest.fn();
const mockRevocationUpdateCallMembers = jest.fn();

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
  appointmentOccurrence: {
    findMany: jest.fn(async (): Promise<unknown[]> => []),
  },
  appointment: {
    findUnique: jest.fn(async (): Promise<unknown> => null),
  },
  appointmentParticipant: {
    findFirst: jest.fn(async (): Promise<unknown> => null),
    findMany: jest.fn(async (): Promise<unknown[]> => []),
  },
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
  getStreamVideoClient: () => ({
    video: {
      call: (type: string, id: string) => ({
        updateCallMembers: (payload: unknown) =>
          mockRevocationUpdateCallMembers(type, id, payload),
      }),
    },
  }),
  isStreamConfigured: () => true,
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
const mockRecordSystemEvent = jest.fn();
jest.mock("../../lib/enterprise/system-events", () => ({
  recordSystemEvent: (...args: unknown[]) => mockRecordSystemEvent(...args),
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

describe("call membership on booking end", () => {
  beforeEach(() => {
    mockRevocationUpdateCallMembers.mockResolvedValue({});
    mockRevocationPrisma.appointmentOccurrence.findMany.mockResolvedValue([
      { meeting: { streamCallId: "occurrence-o1" } },
      { meeting: null },
    ]);
  });

  it("removes the attendee from the event's unended calls", async () => {
    mockRevocationPrisma.webinar.findUnique.mockResolvedValue({
      ...webinarRoster,
      appointment: { ...webinarRoster.appointment, id: "appt-1" },
    });
    const { revokeEndedEventChatAccess } =
      await import("../../lib/stream/access-revocation");

    await revokeEndedEventChatAccess("webinar", "w1", ["attendee-1"]);

    expect(
      mockRevocationPrisma.appointmentOccurrence.findMany,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          appointmentId: "appt-1",
          meeting: { is: { endedAt: null } },
        }),
      }),
    );
    expect(mockRevocationUpdateCallMembers).toHaveBeenCalledTimes(1);
    expect(mockRevocationUpdateCallMembers).toHaveBeenCalledWith(
      "default",
      "occurrence-o1",
      { remove_members: ["attendee-1"] },
    );
  });

  it("queues CALL_MEMBER_REMOVE when Stream refuses the removal", async () => {
    mockRevocationUpdateCallMembers.mockRejectedValue(
      new Error("Stream is down"),
    );
    const { revokeEndedBookingChatAccess } =
      await import("../../lib/stream/access-revocation");

    await revokeEndedBookingChatAccess({
      userIds: ["client-1"],
      dmCounterpartUserIds: [],
      dmOrganizationId: null,
      appointmentId: "appt-1",
    });

    expect(
      mockRevocationPrisma.streamRevocationRetry.createMany,
    ).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          kind: "CALL_MEMBER_REMOVE",
          userId: "client-1",
          planId: "appt-1",
        }),
      ],
      skipDuplicates: true,
    });
  });

  it("leaves calls alone when no appointment is given", async () => {
    const { revokeEndedBookingChatAccess } =
      await import("../../lib/stream/access-revocation");

    await revokeEndedBookingChatAccess({
      userIds: ["client-1"],
      dmCounterpartUserIds: [],
      dmOrganizationId: null,
    });

    expect(
      mockRevocationPrisma.appointmentOccurrence.findMany,
    ).not.toHaveBeenCalled();
    expect(mockRevocationUpdateCallMembers).not.toHaveBeenCalled();
  });

  const retryRow = {
    kind: "CALL_MEMBER_REMOVE" as const,
    userId: "client-1",
    planId: "appt-1",
    planType: null,
    counterpartUserId: null,
    createdAt: new Date(),
  };

  it("redrive skips a user Postgres re-admitted to the booking", async () => {
    mockRevocationPrisma.appointmentParticipant.findFirst.mockResolvedValue({
      id: "seat-2",
    });
    const { redriveAccessRevocation } =
      await import("../../lib/stream/access-revocation");

    await expect(redriveAccessRevocation(retryRow)).resolves.toBeNull();
    expect(mockRevocationUpdateCallMembers).not.toHaveBeenCalled();
  });

  it("redrive on a group room counts only a paid seat as re-admitted", async () => {
    mockRevocationPrisma.appointment.findUnique.mockResolvedValue({
      webinarId: "w1",
      classId: null,
    });
    const { redriveAccessRevocation } =
      await import("../../lib/stream/access-revocation");
    const { paidParticipant } = await import("../../lib/booking/participants");

    await redriveAccessRevocation(retryRow);

    expect(
      mockRevocationPrisma.appointmentParticipant.findFirst,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { appointmentId: "appt-1", ...paidParticipant("client-1") },
      }),
    );
  });

  it("redrive removes a user who holds no live seat, and reports a failure", async () => {
    mockRevocationPrisma.appointmentParticipant.findFirst.mockResolvedValue(
      null,
    );
    const { redriveAccessRevocation } =
      await import("../../lib/stream/access-revocation");

    await expect(redriveAccessRevocation(retryRow)).resolves.toBeNull();
    expect(mockRevocationUpdateCallMembers).toHaveBeenCalledWith(
      "default",
      "occurrence-o1",
      { remove_members: ["client-1"] },
    );

    mockRevocationUpdateCallMembers.mockRejectedValue(
      new Error("Stream is down"),
    );
    await expect(redriveAccessRevocation(retryRow)).resolves.toBe(
      "Call membership removal failed",
    );
  });
});

describe("access after a refund ends a seat", () => {
  const oneToOneSeat = (status: string) => ({
    userId: "client-1",
    appointmentId: "appt-1",
    appointment: {
      webinarId: null,
      classId: null,
      organizationId: null,
      webinar: null,
      class: null,
      consultation: {
        status,
        consultationPlan: {
          organizationId: "org-1",
          consultantProfile: { userId: "host-1" },
        },
      },
      subscription: null,
      trial: null,
    },
  });

  beforeEach(() => {
    mockRevocationUpdateCallMembers.mockResolvedValue({});
    mockIsDmContextEligible.mockResolvedValue(false);
    mockRevocationPrisma.appointmentParticipant.findFirst.mockResolvedValue(
      null,
    );
    mockRevocationPrisma.appointmentOccurrence.findMany.mockResolvedValue([
      { meeting: { streamCallId: "occurrence-o1" } },
    ]);
  });

  it("removes a refunded 1:1 client from the DM and the call", async () => {
    mockRevocationPrisma.appointmentParticipant.findMany.mockResolvedValue([
      oneToOneSeat("SCHEDULED"),
    ]);
    const { revokeRefundedSeatAccess } =
      await import("../../lib/stream/access-revocation");

    await revokeRefundedSeatAccess("pay-1");

    expect(
      mockRevocationPrisma.appointmentParticipant.findMany,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { paymentId: "pay-1", status: "REFUNDED" },
      }),
    );
    expect(mockIsDmContextEligible).toHaveBeenCalledWith(
      "host-1",
      "client-1",
      "org-1",
    );
    expect(mockRemoveMembers).toHaveBeenCalledTimes(1);
    expect(mockRevocationUpdateCallMembers).toHaveBeenCalledWith(
      "default",
      "occurrence-o1",
      { remove_members: ["client-1"] },
    );
  });

  it("leaves a cancelled booking and a still-live seat to their own paths", async () => {
    mockRevocationPrisma.appointmentParticipant.findMany.mockResolvedValue([
      oneToOneSeat("CANCELLED"),
    ]);
    const { revokeRefundedSeatAccess } =
      await import("../../lib/stream/access-revocation");

    await revokeRefundedSeatAccess("pay-1");

    mockRevocationPrisma.appointmentParticipant.findMany.mockResolvedValue([
      oneToOneSeat("SCHEDULED"),
    ]);
    mockRevocationPrisma.appointmentParticipant.findFirst.mockResolvedValue({
      id: "seat-2",
    });
    await revokeRefundedSeatAccess("pay-1");

    expect(mockRemoveMembers).not.toHaveBeenCalled();
    expect(mockRevocationUpdateCallMembers).not.toHaveBeenCalled();
  });

  it("never throws when the lookup fails", async () => {
    mockRevocationPrisma.appointmentParticipant.findMany.mockRejectedValue(
      new Error("db down"),
    );
    const { revokeRefundedSeatAccess } =
      await import("../../lib/stream/access-revocation");

    await expect(revokeRefundedSeatAccess("pay-1")).resolves.toBeUndefined();
    expect(mockReport).toHaveBeenCalledTimes(1);
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

  it("asks for paid seats only, so an unpaid HELD seat is not a chat member", async () => {
    mockRevocationPrisma.webinar.findFirst.mockClear();
    mockRevocationPrisma.webinar.findFirst.mockImplementation(openableWebinar);
    const { eventParticipantsAmong } =
      await import("../../lib/stream/event-channel-service");
    const { paidParticipant } = await import("../../lib/booking/participants");

    await eventParticipantsAmong("webinar", "w1", ["attendee-keep"]);

    const query = mockRevocationPrisma.webinar.findFirst.mock.calls[0][0];
    expect(query.select.appointment.select.participants.where).toEqual({
      ...paidParticipant(),
      userId: { in: ["attendee-keep"] },
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
    // Removals and brakes are a console finding, not a Sentry event.
    expect(mockReport).not.toHaveBeenCalled();
    expect(mockRecordSystemEvent).toHaveBeenCalledTimes(1);
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
