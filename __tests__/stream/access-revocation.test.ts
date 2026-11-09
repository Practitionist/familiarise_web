/**
 * @jest-environment node
 */

const mockRemoveMembers = jest.fn();
const mockRevocationQueryChannels = jest.fn();
const mockReport = jest.fn();
const mockIsDmContextEligible = jest.fn();
const mockRevocationUpdateCallMembers = jest.fn();
const mockRevocationGetCall = jest.fn();
const mockRestampRefundedSeats = jest.fn();

type RetryRow = {
  id: string;
  kind: string;
  planId: string;
  userId: string;
  status: string;
  resumeAfter: string | null;
  updatedAt: Date;
};
/** Seat intents as Postgres would hold them, for the drive's room cursor. */
let retryRows: RetryRow[] = [];

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
    updateMany: jest.fn(async (args: unknown) => {
      const { where, data } = args as {
        where: { OR?: { id?: string; updatedAt?: Date }[] };
        data: { resumeAfter?: string | null };
      };
      if (data.resumeAfter === undefined) return { count: 0 };
      let count = 0;
      for (const row of retryRows) {
        const hit = (where.OR ?? []).some(
          (w) =>
            w.id === row.id &&
            (w.updatedAt === undefined ||
              w.updatedAt.getTime() === row.updatedAt.getTime()),
        );
        if (!hit || row.status === "SUCCEEDED") continue;
        row.resumeAfter = data.resumeAfter;
        row.updatedAt = new Date(row.updatedAt.getTime() + 1);
        count++;
      }
      return { count };
    }),
    createMany: jest.fn(async (_args: unknown) => ({ count: 1 })),
    findMany: jest.fn(async (args: unknown): Promise<unknown[]> => {
      const { where } = args as {
        where: { kind: string; planId: string; userId: { in: string[] } };
      };
      return retryRows
        .filter(
          (r) =>
            r.kind === where.kind &&
            r.planId === where.planId &&
            where.userId.in.includes(r.userId) &&
            r.status !== "SUCCEEDED",
        )
        .map((r) => ({ ...r }));
    }),
  },
  refund: {
    findUnique: jest.fn(async (): Promise<unknown> => ({ paymentId: "pay-1" })),
  },
  webinar: { findUnique: jest.fn(), findFirst: jest.fn() },
  class: { findUnique: jest.fn(), findFirst: jest.fn() },
  webinarPlan: { findUnique: jest.fn() },
  classPlan: { findUnique: jest.fn() },
  membership: { findFirst: jest.fn() },
  user: {
    findMany: jest.fn(async (_args?: unknown): Promise<unknown[]> => []),
  },
  appointment: { findUnique: jest.fn(async (): Promise<unknown> => null) },
  payment: {
    findUnique: jest.fn(async (): Promise<unknown> => ({ userId: "payer-1" })),
  },
  meeting: {
    findMany: jest.fn(async (_args: unknown): Promise<unknown[]> => []),
    findFirst: jest.fn(async (_args: unknown): Promise<unknown> => null),
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
jest.mock("../../lib/payments/operations/booking-refund", () => ({
  restampRefundedSeats: (...args: unknown[]) =>
    mockRestampRefundedSeats(...args),
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
  occurrences: [] as { consultantProfileId: string | null }[],
  webinar: { id: "w1", status: "SCHEDULED", webinarPlan: plan("host-1") },
  class: null,
  consultation: null,
  subscription: null,
  trial: null,
};

const directSeatContext = (status: string) => ({
  deletedAt: null,
  organizationId: null,
  occurrences: [],
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
  mockRevocationPrisma.meeting.findFirst.mockImplementation(
    async (args: unknown) => {
      const { where } = args as { where: { id: string } };
      return rows.find((r) => r.id === where.id) ?? null;
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
  retryRows = [];
  mockRestampRefundedSeats.mockResolvedValue("stamped");
  mockRevocationPrisma.refund.findUnique.mockResolvedValue({
    paymentId: "pay-1",
  });
  mockRevocationPrisma.user.findMany.mockResolvedValue([]);
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
    expect(queries[0]).toMatchObject({
      where: { occurrence: { appointmentId: "appt-1" } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
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

const refundIntent = { refundId: "refund-1", payerUserId: "payer-1" };

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

  it("persists a refund intent before any read, then seat intents, and settles both", async () => {
    seats.refunded = [refundedSeat("SCHEDULED")];
    const { revokeRefundedSeatAccess } =
      await import("../../lib/stream/access-revocation");

    await revokeRefundedSeatAccess(refundIntent);

    const created =
      mockRevocationPrisma.streamRevocationRetry.createMany.mock.calls.map(
        ([args]) => (args as { data: { kind: string }[] }).data[0],
      );
    expect(created).toEqual([
      expect.objectContaining({
        kind: "REFUND_ACCESS_REVOKE",
        userId: "payer-1",
        planId: "refund-1",
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

    await revokeRefundedSeatAccess(refundIntent);

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

    await expect(
      revokeRefundedSeatAccess(refundIntent),
    ).resolves.toBeUndefined();

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
    planId: kind === "SEAT_ACCESS_REVOKE" ? "appt-1" : "refund-1",
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

    expect(lost).toEqual({ verified: true, lost: ["attendee-1"] });
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

    await expect(fenceSeatGrants("appt-1", ["crew-1"])).resolves.toEqual({
      verified: true,
      lost: [],
    });
    expect(mockRevocationUpdateCallMembers).not.toHaveBeenCalled();
  });

  it("does nothing when every granted seat is still admitted", async () => {
    seats.holders = ["attendee-keep"];
    seats.admitted = ["attendee-keep"];
    const { fenceSeatGrants } =
      await import("../../lib/stream/access-revocation");

    await expect(fenceSeatGrants("appt-1", ["attendee-keep"])).resolves.toEqual(
      { verified: true, lost: [] },
    );
    expect(
      mockRevocationPrisma.streamRevocationRetry.createMany,
    ).not.toHaveBeenCalled();
  });
});

describe("grant fence when the seat check cannot be read", () => {
  it("refuses to vouch for the grant, persists it for the sweep and reports once", async () => {
    mockRevocationPrisma.appointment.findUnique.mockRejectedValueOnce(
      new Error("db timeout after the grant"),
    );
    const { fenceSeatGrants } =
      await import("../../lib/stream/access-revocation");

    await expect(fenceSeatGrants("appt-1", ["attendee-1"])).resolves.toEqual({
      verified: false,
    });

    expect(
      mockRevocationPrisma.streamRevocationRetry.createMany,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [
          expect.objectContaining({
            kind: "SEAT_ACCESS_REVOKE",
            userId: "attendee-1",
            planId: "appt-1",
          }),
        ],
      }),
    );
    expect(mockReport).toHaveBeenCalledTimes(1);
    expect(mockReport).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ op: "seat.fenceGrant" }),
    );
    expect(mockRevocationUpdateCallMembers).not.toHaveBeenCalled();
  });

  it("spares an occurrence host who also holds a lapsed client seat", async () => {
    mockRevocationPrisma.appointment.findUnique.mockResolvedValue({
      ...webinarSeatContext,
      occurrences: [{ consultantProfileId: "cp-occ" }],
    });
    mockRevocationPrisma.user.findMany.mockResolvedValue([{ id: "occ-host" }]);
    seats.holders = ["occ-host"];
    const { fenceSeatGrants } =
      await import("../../lib/stream/access-revocation");

    await expect(fenceSeatGrants("appt-1", ["occ-host"])).resolves.toEqual({
      verified: true,
      lost: [],
    });
    expect(mockRevocationPrisma.user.findMany).toHaveBeenCalledWith({
      where: { consultantProfileId: { in: ["cp-occ"] } },
      select: { id: true },
    });
    expect(mockRevocationUpdateCallMembers).not.toHaveBeenCalled();
  });

  it.each([
    ["the plan host", "host-1"],
    ["an occurrence host", "occ-host"],
  ])(
    "never removes %s named in a fence-failure intent when the sweep drives it",
    async (_label, userId) => {
      mockRevocationPrisma.appointment.findUnique.mockResolvedValue({
        ...webinarSeatContext,
        occurrences: [{ consultantProfileId: "cp-occ" }],
      });
      mockRevocationPrisma.user.findMany.mockResolvedValue([
        { id: "occ-host" },
      ]);
      const { redriveAccessRevocation } =
        await import("../../lib/stream/access-revocation");

      await expect(
        redriveAccessRevocation({
          kind: "SEAT_ACCESS_REVOKE",
          userId,
          planId: "appt-1",
          planType: null,
          counterpartUserId: null,
          createdAt: new Date(),
        }),
      ).resolves.toBeNull();
      expect(mockRemoveMembers).not.toHaveBeenCalled();
      expect(mockRevocationUpdateCallMembers).not.toHaveBeenCalled();
    },
  );
});

describe("room progress across sweep attempts", () => {
  const seatRow = {
    kind: "SEAT_ACCESS_REVOKE" as const,
    userId: "attendee-1",
    planId: "appt-1",
    planType: null,
    counterpartUserId: null,
    createdAt: new Date(),
  };
  const openIntent = (resumeAfter: string | null): RetryRow => ({
    id: "retry-1",
    kind: "SEAT_ACCESS_REVOKE",
    planId: "appt-1",
    userId: "attendee-1",
    status: "PENDING",
    resumeAfter,
    updatedAt: new Date(1_000),
  });
  const visitedRooms = () =>
    mockRevocationUpdateCallMembers.mock.calls.map(([, id]) => id as string);

  it("covers all 7 rooms within 6 budget-limited attempts at 5 s per removal", async () => {
    serveMeetings(meetings(7));
    retryRows = [openIntent(null)];
    let now = 1_000_000;
    jest.spyOn(Date, "now").mockImplementation(() => now);
    // Each removal takes 5 s once Stream has it.
    mockRevocationUpdateCallMembers.mockImplementation(async () => {
      await Promise.resolve();
      now += 5_000;
      return {};
    });
    const { redriveAccessRevocation } =
      await import("../../lib/stream/access-revocation");

    const outcomes: (string | null)[] = [];
    for (let attempt = 0; attempt < 6; attempt++) {
      const outcome = await redriveAccessRevocation(seatRow);
      outcomes.push(outcome);
      if (outcome === null) break;
      now += 60_000;
    }

    expect(outcomes).toEqual(["time budget spent before call removal", null]);
    expect(visitedRooms()).toEqual(meetings(7).map((m) => m.streamCallId));
    expect(retryRows[0].resumeAfter).toBe("m003");
  });

  it("stops a user's cursor at a room that kept them, while the scan goes on", async () => {
    serveMeetings(meetings(3));
    retryRows = [openIntent(null)];
    mockRevocationUpdateCallMembers.mockImplementation(
      async (_type: string, id: string) => {
        if (id === "occurrence-1") throw new Error("refused");
        return {};
      },
    );
    const { redriveAccessRevocation } =
      await import("../../lib/stream/access-revocation");

    await expect(redriveAccessRevocation(seatRow)).resolves.toBe(
      "call removal failed",
    );
    expect(visitedRooms()).toEqual([
      "occurrence-0",
      "occurrence-1",
      "occurrence-2",
    ]);
    expect(retryRows[0].resumeAfter).toBe("m000");
  });

  it("resumes after the saved room and still visits rooms created after it", async () => {
    serveMeetings(meetings(5));
    retryRows = [openIntent("m002")];
    const { redriveAccessRevocation } =
      await import("../../lib/stream/access-revocation");

    await expect(redriveAccessRevocation(seatRow)).resolves.toBeNull();
    expect(visitedRooms()).toEqual(["occurrence-3", "occurrence-4"]);
  });

  it("rescans from the first room when the saved room no longer exists", async () => {
    serveMeetings(meetings(2));
    retryRows = [openIntent("m-deleted")];
    const { redriveAccessRevocation } =
      await import("../../lib/stream/access-revocation");

    await expect(redriveAccessRevocation(seatRow)).resolves.toBeNull();
    expect(visitedRooms()).toEqual(["occurrence-0", "occurrence-1"]);
  });

  it("keeps no progress from a drive whose row was re-armed meanwhile", async () => {
    serveMeetings(meetings(2));
    retryRows = [openIntent(null)];
    let first = true;
    mockRevocationUpdateCallMembers.mockImplementation(async () => {
      if (first) {
        first = false;
        retryRows[0].updatedAt = new Date(5_000);
        return {};
      }
      throw new Error("down");
    });
    const { redriveAccessRevocation } =
      await import("../../lib/stream/access-revocation");

    await redriveAccessRevocation(seatRow);

    expect(retryRows[0].resumeAfter).toBeNull();
  });

  it("re-arming an open intent restarts its room scan", async () => {
    const { enqueueStreamRevocationRetries } =
      await import("../../lib/stream/access-revocation");

    await enqueueStreamRevocationRetries(
      [{ kind: "SEAT_ACCESS_REVOKE", userId: "attendee-1", planId: "appt-1" }],
      new Date(),
    );

    expect(
      mockRevocationPrisma.streamRevocationRetry.updateMany,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "PENDING", resumeAfter: null }),
      }),
    );
  });
});

describe("refund intent keyed by the Refund row", () => {
  it("writes the intent even when every read after it fails", async () => {
    mockRevocationPrisma.refund.findUnique.mockRejectedValue(
      new Error("db down"),
    );
    const { revokeRefundedSeatAccess } =
      await import("../../lib/stream/access-revocation");

    await expect(
      revokeRefundedSeatAccess(refundIntent),
    ).resolves.toBeUndefined();

    expect(
      mockRevocationPrisma.streamRevocationRetry.createMany,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [
          expect.objectContaining({
            kind: "REFUND_ACCESS_REVOKE",
            userId: "payer-1",
            planId: "refund-1",
          }),
        ],
      }),
    );
    expect(mockRevocationPrisma.payment.findUnique).not.toHaveBeenCalled();
    expect(settledCalls()).toHaveLength(0);
  });

  it("re-stamps the refund's seats before the sweep discovers and revokes them", async () => {
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
      redriveAccessRevocation({
        kind: "REFUND_ACCESS_REVOKE",
        userId: "payer-1",
        planId: "refund-1",
        planType: null,
        counterpartUserId: null,
        createdAt: new Date(),
      }),
    ).resolves.toBeNull();

    expect(mockRestampRefundedSeats).toHaveBeenCalledWith("refund-1");
    const discovery =
      mockRevocationPrisma.appointmentParticipant.findMany.mock
        .invocationCallOrder[0];
    expect(mockRestampRefundedSeats.mock.invocationCallOrder[0]).toBeLessThan(
      discovery,
    );
    expect(
      mockRevocationPrisma.appointmentParticipant.findMany,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { paymentId: "pay-1", status: "REFUNDED" },
      }),
    );
    expect(mockRevocationUpdateCallMembers).toHaveBeenCalledWith(
      "default",
      "occurrence-0",
      { remove_members: ["client-1"] },
    );
  });

  it("settles a failed refund's intent with no seat to revoke", async () => {
    mockRestampRefundedSeats.mockResolvedValue("skipped");
    const { revokeRefundedSeatAccess } =
      await import("../../lib/stream/access-revocation");

    await revokeRefundedSeatAccess(refundIntent);

    expect(mockRevocationUpdateCallMembers).not.toHaveBeenCalled();
    expect(settledCalls()).toEqual([
      expect.objectContaining({
        where: expect.objectContaining({
          kind: "REFUND_ACCESS_REVOKE",
          planId: "refund-1",
        }),
      }),
    ]);
  });

  it("keeps the intent owed while its Refund row cannot be found", async () => {
    mockRevocationPrisma.refund.findUnique.mockResolvedValue(null);
    const { redriveAccessRevocation } =
      await import("../../lib/stream/access-revocation");

    await expect(
      redriveAccessRevocation({
        kind: "REFUND_ACCESS_REVOKE",
        userId: "payer-1",
        planId: "refund-1",
        planType: null,
        counterpartUserId: null,
        createdAt: new Date(),
      }),
    ).resolves.toBe("Refund row not found");
    expect(mockRestampRefundedSeats).not.toHaveBeenCalled();
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

describe("a writer settles only the intent generation it wrote", () => {
  const writtenGenerations = () =>
    mockRevocationPrisma.streamRevocationRetry.createMany.mock.calls.map(
      ([args]) =>
        (args as { data: { kind: string; nextRetryAt: Date }[] }).data[0],
    );

  it("settles the seat rows at the generation its own persist wrote", async () => {
    const { revokeEndedSeatAccess } =
      await import("../../lib/stream/access-revocation");

    await revokeEndedSeatAccess("appt-1", ["attendee-1"]);

    const [written] = writtenGenerations();
    const rearm = mockRevocationPrisma.streamRevocationRetry.updateMany.mock
      .calls[0][0] as { data: { nextRetryAt: Date } };
    expect(rearm.data.nextRetryAt).toBe(written.nextRetryAt);
    expect(settledCalls()).toEqual([
      expect.objectContaining({
        where: expect.objectContaining({
          kind: "SEAT_ACCESS_REVOKE",
          nextRetryAt: written.nextRetryAt,
        }),
      }),
    ]);
  });

  it("settles nothing when its own persist failed, so another writer's row stays owed", async () => {
    mockRevocationPrisma.streamRevocationRetry.createMany.mockRejectedValueOnce(
      new Error("db down"),
    );
    const { revokeEndedSeatAccess } =
      await import("../../lib/stream/access-revocation");

    await revokeEndedSeatAccess("appt-1", ["attendee-1"]);

    expect(mockRevocationUpdateCallMembers).toHaveBeenCalled();
    expect(settledCalls()).toHaveLength(0);
  });

  it("settles a refund's seat and refund rows each at its own generation", async () => {
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
    let tick = 2_000_000;
    jest.spyOn(Date, "now").mockImplementation(() => (tick += 1));
    const { revokeRefundedSeatAccess } =
      await import("../../lib/stream/access-revocation");

    await revokeRefundedSeatAccess(refundIntent);

    const [refundRow, seatRow] = writtenGenerations();
    expect(refundRow.kind).toBe("REFUND_ACCESS_REVOKE");
    expect(seatRow.kind).toBe("SEAT_ACCESS_REVOKE");
    expect(refundRow.nextRetryAt).not.toEqual(seatRow.nextRetryAt);
    expect(
      settledCalls().map((c) => [c.where.kind, c.where.nextRetryAt]),
    ).toEqual([
      ["SEAT_ACCESS_REVOKE", seatRow.nextRetryAt],
      ["REFUND_ACCESS_REVOKE", refundRow.nextRetryAt],
    ]);
  });

  it("settles a refund's driven seats in one write at the seat generation, leaving a pending seat owed", async () => {
    const seatOf = (userId: string, appointmentId: string) => ({
      userId,
      appointmentId,
      appointment: {
        webinar: null,
        class: null,
        consultation: { status: "SCHEDULED" },
        subscription: null,
        trial: null,
      },
    });
    seats.refunded = [
      seatOf("client-1", "appt-1"),
      seatOf("client-2", "appt-2"),
      seatOf("client-3", "appt-3"),
    ];
    mockRevocationPrisma.appointment.findUnique.mockResolvedValue(
      directSeatContext("SCHEDULED"),
    );
    mockRevocationUpdateCallMembers.mockImplementation(
      async (_type: string, _id: string, payload: unknown) => {
        const { remove_members } = payload as { remove_members: string[] };
        if (remove_members.includes("client-2")) throw new Error("down");
        return {};
      },
    );
    let tick = 3_000_000;
    jest.spyOn(Date, "now").mockImplementation(() => (tick += 1));
    const { revokeRefundedSeatAccess } =
      await import("../../lib/stream/access-revocation");

    await revokeRefundedSeatAccess(refundIntent);

    const seatRow = writtenGenerations().find(
      (r) => r.kind === "SEAT_ACCESS_REVOKE",
    );
    const seatSettles = settledCalls().filter(
      (c) => c.where.kind === "SEAT_ACCESS_REVOKE",
    );
    expect(seatSettles).toEqual([
      expect.objectContaining({
        where: expect.objectContaining({
          erasureRequestId: null,
          status: { in: ["PENDING", "FAILED"] },
          nextRetryAt: seatRow?.nextRetryAt,
          OR: [
            { planId: "appt-1", userId: "client-1" },
            { planId: "appt-3", userId: "client-3" },
          ],
        }),
      }),
    ]);
  });

  it("gives a queued collaborator row a fresh generation the sweep can check", async () => {
    const { enqueueCollaboratorRevocationRetry } =
      await import("../../lib/stream/access-revocation");

    await enqueueCollaboratorRevocationRetry("webinar", "plan-1", "collab-1");

    const [written] = writtenGenerations();
    expect(written.nextRetryAt).toBeInstanceOf(Date);
  });
});
