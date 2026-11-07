/**
 * @jest-environment node
 */

const mockRemoveMembers = jest.fn();
const mockRevocationQueryChannels = jest.fn();
const mockReport = jest.fn();
const mockIsDmContextEligible = jest.fn();
const mockRevocationUpdateCallMembers = jest.fn();
const mockRevocationGetCall = jest.fn();

type ParticipantWhere = {
  paymentId?: string;
  status?: unknown;
  OR?: unknown;
  userId?: { in: string[] };
};

/** Seat rows by query: refunded seats by payment, admitted seats by status, else any seat held. */
const seats = {
  refunded: [] as unknown[],
  admitted: [] as string[],
  holders: [] as string[],
};

const mockRevocationPrisma = {
  streamRevocationRetry: {
    updateMany: jest.fn(async (_args: unknown) => ({ count: 0 })),
    createMany: jest.fn(async (_args: unknown) => ({ count: 1 })),
  },
  webinar: { findUnique: jest.fn(), findFirst: jest.fn() },
  class: { findUnique: jest.fn(), findFirst: jest.fn() },
  webinarPlan: { findUnique: jest.fn() },
  classPlan: { findUnique: jest.fn() },
  membership: { findFirst: jest.fn() },
  user: { findMany: jest.fn(async () => []) },
  appointment: { findUnique: jest.fn(async (): Promise<unknown> => null) },
  payment: {
    findUnique: jest.fn(async (): Promise<unknown> => ({ userId: "payer-1" })),
  },
  meeting: {
    findMany: jest.fn(async (_args: unknown): Promise<unknown[]> => []),
  },
  appointmentParticipant: {
    findMany: jest.fn(
      async ({ where }: { where: ParticipantWhere }): Promise<unknown[]> => {
        if (where.paymentId) return seats.refunded;
        const asked = where.userId?.in ?? [];
        const pool = where.status || where.OR ? seats.admitted : seats.holders;
        return pool
          .filter((id) => asked.includes(id))
          .map((userId) => ({ userId }));
      },
    ),
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
        get: () => mockRevocationGetCall(id),
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

const plan = (hostUserId: string) => ({
  organizationId: null,
  consultantProfile: { userId: hostUserId },
  collaborators: [],
});

const webinarSeatContext = {
  deletedAt: null,
  organizationId: null,
  webinar: { id: "w1", status: "SCHEDULED", webinarPlan: plan("host-1") },
  class: null,
  consultation: null,
  subscription: null,
  trial: null,
};

const directSeatContext = (status: string) => ({
  deletedAt: null,
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
});

const meetings = (count: number) =>
  Array.from({ length: count }, (_, i) => ({
    id: `m${String(i).padStart(3, "0")}`,
    streamCallId: `occurrence-${i}`,
  }));

/** Answers `meeting.findMany` page by page from `rows`, honouring the cursor. */
function serveMeetings(rows: { id: string; streamCallId: string }[]) {
  mockRevocationPrisma.meeting.findMany.mockImplementation(
    async (args: unknown) => {
      const { take, cursor } = args as {
        take: number;
        cursor?: { id: string };
      };
      const start = cursor ? rows.findIndex((r) => r.id === cursor.id) + 1 : 0;
      return rows.slice(start, start + take);
    },
  );
}

const settledCalls = () =>
  mockRevocationPrisma.streamRevocationRetry.updateMany.mock.calls
    .map(
      ([args]) =>
        args as { where: Record<string, unknown>; data: { status: string } },
    )
    .filter((args) => args.data.status === "SUCCEEDED");

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
  seats.refunded = [];
  seats.admitted = [];
  seats.holders = [];
  mockRemoveMembers.mockResolvedValue({});
  mockRevocationUpdateCallMembers.mockResolvedValue({});
  mockRevocationGetCall.mockResolvedValue({ call: { ended_at: undefined } });
  mockIsDmContextEligible.mockResolvedValue(false);
  mockRevocationPrisma.webinar.findUnique.mockResolvedValue(webinarRoster);
  mockRevocationPrisma.appointment.findUnique.mockResolvedValue(
    webinarSeatContext,
  );
  mockRevocationPrisma.payment.findUnique.mockResolvedValue({
    userId: "payer-1",
  });
  serveMeetings(meetings(1));
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("revocation when a seat or booking ends", () => {
  it("persists the intent before any lookup or Stream call, then settles it", async () => {
    const { revokeEndedSeatAccess } =
      await import("../../lib/stream/access-revocation");

    await revokeEndedSeatAccess("appt-1", ["attendee-1"]);

    const created = mockRevocationPrisma.streamRevocationRetry.createMany.mock;
    expect(created.calls[0][0]).toMatchObject({
      data: [
        {
          kind: "SEAT_ACCESS_REVOKE",
          userId: "attendee-1",
          planId: "appt-1",
          nextRetryAt: expect.any(Date),
        },
      ],
      skipDuplicates: true,
    });
    const firstLookup =
      mockRevocationPrisma.appointment.findUnique.mock.invocationCallOrder[0];
    expect(created.invocationCallOrder[0]).toBeLessThan(firstLookup);
    expect(mockRemoveMembers).toHaveBeenCalledWith("team", "webinar-w1", [
      "attendee-1",
    ]);
    expect(mockRemoveMembers).toHaveBeenCalledWith(
      "messaging",
      expect.any(String),
      ["attendee-1"],
    );
    expect(mockRevocationUpdateCallMembers).toHaveBeenCalledWith(
      "default",
      "occurrence-0",
      { remove_members: ["attendee-1"] },
    );
    expect(settledCalls()).toEqual([
      expect.objectContaining({
        where: expect.objectContaining({
          kind: "SEAT_ACCESS_REVOKE",
          planId: "appt-1",
          userId: { in: ["attendee-1"] },
        }),
      }),
    ]);
  });

  it("keeps a DM another booking still justifies and leaves an admitted seat alone", async () => {
    mockIsDmContextEligible.mockResolvedValue(true);
    seats.admitted = ["attendee-keep"];
    const { revokeEndedSeatAccess } =
      await import("../../lib/stream/access-revocation");

    await revokeEndedSeatAccess("appt-1", ["attendee-keep", "attendee-1"]);

    expect(mockRemoveMembers).toHaveBeenCalledTimes(1);
    expect(mockRemoveMembers).toHaveBeenCalledWith("team", "webinar-w1", [
      "attendee-1",
    ]);
    expect(mockRevocationUpdateCallMembers).toHaveBeenCalledWith(
      "default",
      "occurrence-0",
      { remove_members: ["attendee-1"] },
    );
  });

  it("revokes a live 1:1 seat whose booking was cancelled", async () => {
    mockRevocationPrisma.appointment.findUnique.mockResolvedValue(
      directSeatContext("CANCELLED"),
    );
    seats.admitted = ["client-1"];
    const { revokeEndedSeatAccess } =
      await import("../../lib/stream/access-revocation");

    await revokeEndedSeatAccess("appt-1", ["client-1"]);

    expect(mockIsDmContextEligible).toHaveBeenCalledWith(
      "host-1",
      "client-1",
      "org-1",
    );
    expect(mockRevocationUpdateCallMembers).toHaveBeenCalledTimes(1);
  });

  it("reads every provisioned room, whatever Postgres says about its end, page by page", async () => {
    serveMeetings(meetings(51));
    const { revokeEndedSeatAccess } =
      await import("../../lib/stream/access-revocation");

    await revokeEndedSeatAccess("appt-1", ["attendee-1"]);

    const queries = mockRevocationPrisma.meeting.findMany.mock.calls.map(
      ([args]) => args as { where: unknown; take: number },
    );
    expect(queries[0].where).toEqual({
      occurrence: { appointmentId: "appt-1" },
    });
    expect(queries).toHaveLength(2);
    expect(mockRevocationUpdateCallMembers).toHaveBeenCalledTimes(51);
    expect(settledCalls()).toHaveLength(1);
  });

  it("counts a refused room as done only when Stream reports it ended", async () => {
    serveMeetings(meetings(2));
    mockRevocationUpdateCallMembers.mockRejectedValue(new Error("refused"));
    mockRevocationGetCall.mockImplementation(async (id: string) => ({
      call: { ended_at: id === "occurrence-0" ? new Date() : undefined },
    }));
    const { revokeEndedSeatAccess } =
      await import("../../lib/stream/access-revocation");

    await revokeEndedSeatAccess("appt-1", ["attendee-1"]);

    expect(mockRevocationGetCall).toHaveBeenCalledTimes(2);
    expect(settledCalls()).toHaveLength(0);
  });

  it("stops at the request budget and leaves the persisted intent owed", async () => {
    serveMeetings(meetings(3));
    let now = 1_000_000;
    jest.spyOn(Date, "now").mockImplementation(() => now);
    mockRevocationUpdateCallMembers.mockImplementation(async () => {
      now += 5_000;
      return {};
    });
    const { revokeEndedSeatAccess } =
      await import("../../lib/stream/access-revocation");

    await revokeEndedSeatAccess("appt-1", ["attendee-1"]);

    expect(
      mockRevocationPrisma.streamRevocationRetry.createMany,
    ).toHaveBeenCalledTimes(1);
    expect(mockRevocationUpdateCallMembers).toHaveBeenCalledTimes(2);
    expect(settledCalls()).toHaveLength(0);
  });

  it("stops waiting on a hung Stream call once the budget is spent", async () => {
    jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] });
    mockRevocationUpdateCallMembers.mockImplementation(
      () => new Promise(() => undefined),
    );
    const { revokeEndedSeatAccess } =
      await import("../../lib/stream/access-revocation");

    const run = revokeEndedSeatAccess("appt-1", ["attendee-1"]);
    await jest.advanceTimersByTimeAsync(8_001);
    await run;
    jest.useRealTimers();

    expect(mockRevocationGetCall).not.toHaveBeenCalled();
    expect(settledCalls()).toHaveLength(0);
  });

  it("persists without driving when the caller still has slow work ahead", async () => {
    const { persistSeatRevocation } =
      await import("../../lib/stream/access-revocation");

    await persistSeatRevocation("appt-1", ["attendee-1", "attendee-1"]);

    expect(
      mockRevocationPrisma.streamRevocationRetry.createMany,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [expect.objectContaining({ kind: "SEAT_ACCESS_REVOKE" })],
      }),
    );
    expect(mockRevocationPrisma.appointment.findUnique).not.toHaveBeenCalled();
    expect(mockRemoveMembers).not.toHaveBeenCalled();
  });

  it("keeps the intent owed when the seat lookup fails", async () => {
    mockRevocationPrisma.appointment.findUnique.mockRejectedValue(
      new Error("db timeout"),
    );
    const { revokeEndedSeatAccess } =
      await import("../../lib/stream/access-revocation");

    await expect(
      revokeEndedSeatAccess("appt-1", ["attendee-1"]),
    ).resolves.toBeUndefined();

    expect(
      mockRevocationPrisma.streamRevocationRetry.createMany,
    ).toHaveBeenCalledTimes(1);
    expect(mockRemoveMembers).not.toHaveBeenCalled();
    expect(settledCalls()).toHaveLength(0);
  });
});

describe("refund revocation", () => {
  const refundedSeat = (status: string) => ({
    userId: "client-1",
    appointmentId: "appt-1",
    appointment: {
      webinar: null,
      class: null,
      consultation: { status },
      subscription: null,
      trial: null,
    },
  });

  beforeEach(() => {
    mockRevocationPrisma.appointment.findUnique.mockResolvedValue(
      directSeatContext("SCHEDULED"),
    );
  });

  it("persists a payment intent before seat discovery, then seat intents, and settles both", async () => {
    seats.refunded = [refundedSeat("SCHEDULED")];
    const { revokeRefundedSeatAccess } =
      await import("../../lib/stream/access-revocation");

    await revokeRefundedSeatAccess("pay-1");

    const created =
      mockRevocationPrisma.streamRevocationRetry.createMany.mock.calls.map(
        ([args]) => (args as { data: { kind: string }[] }).data[0],
      );
    expect(created).toEqual([
      expect.objectContaining({
        kind: "REFUND_ACCESS_REVOKE",
        userId: "payer-1",
        planId: "pay-1",
      }),
      expect.objectContaining({
        kind: "SEAT_ACCESS_REVOKE",
        userId: "client-1",
        planId: "appt-1",
      }),
    ]);
    expect(mockRevocationUpdateCallMembers).toHaveBeenCalledWith(
      "default",
      "occurrence-0",
      { remove_members: ["client-1"] },
    );
    expect(settledCalls().map((c) => c.where.kind)).toEqual([
      "SEAT_ACCESS_REVOKE",
      "REFUND_ACCESS_REVOKE",
    ]);
  });

  it("leaves a cancelled booking's seat to the cancel route's own intent", async () => {
    seats.refunded = [refundedSeat("CANCELLED")];
    const { revokeRefundedSeatAccess } =
      await import("../../lib/stream/access-revocation");

    await revokeRefundedSeatAccess("pay-1");

    expect(
      mockRevocationPrisma.streamRevocationRetry.createMany,
    ).toHaveBeenCalledTimes(1);
    expect(mockRemoveMembers).not.toHaveBeenCalled();
    expect(mockRevocationUpdateCallMembers).not.toHaveBeenCalled();
  });

  it("keeps the payment intent owed when seat discovery fails, and never throws", async () => {
    mockRevocationPrisma.appointmentParticipant.findMany.mockRejectedValueOnce(
      new Error("db down"),
    );
    const { revokeRefundedSeatAccess } =
      await import("../../lib/stream/access-revocation");

    await expect(revokeRefundedSeatAccess("pay-1")).resolves.toBeUndefined();

    expect(
      mockRevocationPrisma.streamRevocationRetry.createMany,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [expect.objectContaining({ kind: "REFUND_ACCESS_REVOKE" })],
      }),
    );
    expect(settledCalls()).toHaveLength(0);
  });
});

describe("sweep redrive", () => {
  const row = (kind: "SEAT_ACCESS_REVOKE" | "REFUND_ACCESS_REVOKE") => ({
    kind,
    userId: kind === "SEAT_ACCESS_REVOKE" ? "attendee-1" : "payer-1",
    planId: kind === "SEAT_ACCESS_REVOKE" ? "appt-1" : "pay-1",
    planType: null,
    counterpartUserId: null,
    createdAt: new Date(),
  });

  it("settles a seat row whose user the gate admits again", async () => {
    seats.admitted = ["attendee-1"];
    const { redriveAccessRevocation } =
      await import("../../lib/stream/access-revocation");

    await expect(
      redriveAccessRevocation(row("SEAT_ACCESS_REVOKE")),
    ).resolves.toBeNull();
    expect(mockRevocationUpdateCallMembers).not.toHaveBeenCalled();
  });

  it("asks for a paid seat on a group room", async () => {
    const { redriveAccessRevocation } =
      await import("../../lib/stream/access-revocation");
    const { paidParticipant } = await import("../../lib/booking/participants");

    await redriveAccessRevocation(row("SEAT_ACCESS_REVOKE"));

    expect(
      mockRevocationPrisma.appointmentParticipant.findMany,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          appointmentId: "appt-1",
          ...paidParticipant(),
          role: "CONSULTEE",
          userId: { in: ["attendee-1"] },
        },
      }),
    );
  });

  it("reports what is still owed", async () => {
    mockRevocationUpdateCallMembers.mockRejectedValue(new Error("down"));
    const { redriveAccessRevocation } =
      await import("../../lib/stream/access-revocation");

    await expect(
      redriveAccessRevocation(row("SEAT_ACCESS_REVOKE")),
    ).resolves.toBe("call removal failed");
  });

  it("re-drives a refund row through its seats", async () => {
    seats.refunded = [
      {
        userId: "client-1",
        appointmentId: "appt-1",
        appointment: {
          webinar: null,
          class: null,
          consultation: { status: "SCHEDULED" },
          subscription: null,
          trial: null,
        },
      },
    ];
    mockRevocationPrisma.appointment.findUnique.mockResolvedValue(
      directSeatContext("SCHEDULED"),
    );
    const { redriveAccessRevocation } =
      await import("../../lib/stream/access-revocation");

    await expect(
      redriveAccessRevocation(row("REFUND_ACCESS_REVOKE")),
    ).resolves.toBeNull();
    expect(mockRevocationUpdateCallMembers).toHaveBeenCalledTimes(1);
  });
});

describe("grant fence", () => {
  it("takes the room back from a seat holder the gate no longer admits, and spares hosts", async () => {
    seats.holders = ["attendee-1", "attendee-keep"];
    seats.admitted = ["attendee-keep"];
    const { fenceSeatGrants } =
      await import("../../lib/stream/access-revocation");

    const lost = await fenceSeatGrants("appt-1", [
      "attendee-1",
      "attendee-keep",
      "host-1",
    ]);

    expect(lost).toEqual(["attendee-1"]);
    expect(mockRevocationUpdateCallMembers).toHaveBeenCalledWith(
      "default",
      "occurrence-0",
      { remove_members: ["attendee-1"] },
    );
  });

  it("spares crew who also hold an old client seat on the appointment", async () => {
    mockRevocationPrisma.appointment.findUnique.mockResolvedValue({
      ...webinarSeatContext,
      webinar: {
        ...webinarSeatContext.webinar,
        webinarPlan: {
          ...plan("host-1"),
          collaborators: [
            { tier: "CREW", consultantProfile: { userId: "crew-1" } },
          ],
        },
      },
    });
    seats.holders = ["crew-1"];
    const { fenceSeatGrants } =
      await import("../../lib/stream/access-revocation");

    await expect(fenceSeatGrants("appt-1", ["crew-1"])).resolves.toEqual([]);
    expect(mockRevocationUpdateCallMembers).not.toHaveBeenCalled();
  });

  it("does nothing when every granted seat is still admitted", async () => {
    seats.holders = ["attendee-keep"];
    seats.admitted = ["attendee-keep"];
    const { fenceSeatGrants } =
      await import("../../lib/stream/access-revocation");

    await expect(fenceSeatGrants("appt-1", ["attendee-keep"])).resolves.toEqual(
      [],
    );
    expect(
      mockRevocationPrisma.streamRevocationRetry.createMany,
    ).not.toHaveBeenCalled();
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
