/** @jest-environment node */

// Answering an invitation through the real service: an accept applies only
// with the terms the invitee saw, on the schedule their calendar was held at.

const mockStageNotices = jest.fn(async (..._args: unknown[]) => ({}));
const mockGrant = jest.fn(async (..._args: unknown[]) => undefined);
const mockSendOwed = jest.fn(async (..._args: unknown[]) => undefined);
const mockWithHostSlotBatch = jest.fn();
jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));
jest.mock("@/lib/collaborators/notifications", () => ({
  stageCollaboratorNotifications: (...args: unknown[]) =>
    mockStageNotices(...args),
  sendOwedCohostEmails: (...args: unknown[]) => mockSendOwed(...args),
}));
jest.mock("@/lib/novu/stage-then-attempt", () => ({
  flushNotificationsAfter: jest.fn(async () => undefined),
}));
jest.mock("@/lib/observability/report", () => ({
  reportSentryError: jest.fn(),
}));
jest.mock("@/lib/stream/collaborator-access", () => ({
  grantCollaboratorAccess: (...args: unknown[]) => mockGrant(...args),
}));
jest.mock("@/lib/stream/access-revocation", () => ({
  persistCollaboratorRevocationInTx: jest.fn(),
  revokeCollaboratorAccess: jest.fn(),
}));
jest.mock("@/lib/booking/host-slot-batch", () => ({
  ...jest.requireActual("@/lib/booking/host-slot-batch"),
  withHostSlotBatch: (...args: unknown[]) => mockWithHostSlotBatch(...args),
}));

type Invitation = {
  id: string;
  consultantProfileId: string;
  webinarPlanId: string | null;
  classPlanId: string | null;
  status: string;
  role: string;
  tier: string;
  revenueShareBps: number;
  acceptedAt: Date | null;
  updatedAt: Date;
};
type Where = Partial<
  Pick<Invitation, "id" | "consultantProfileId" | "role">
> & {
  status?: string | { in: string[] };
  revenueShareBps?: number;
  updatedAt?: { gte: Date };
};
type Query = { where: Where };
type Window = { appointmentId: string; startsAt: Date; endsAt: Date };

const at = (hour: number) => new Date(Date.UTC(2027, 0, 12, hour));
const session = (appointmentId: string, hour: number): Window => ({
  appointmentId,
  startsAt: at(hour),
  endsAt: at(hour + 1),
});
const DAY_MS = 86_400_000;
const sentDaysAgo = (days: number) => new Date(Date.now() - days * DAY_MS);

const eligible = () => ({
  userId: "u-guest",
  deletedAt: null as Date | null,
  verificationStatus: "VERIFIED",
  residencyStatus: "RESIDENT",
  taxInfo: null as { isIndianResident: boolean } | null,
  user: {
    id: "u-guest",
    banned: false as boolean | null,
    banExpires: null as Date | null,
    erasedAt: null as Date | null,
  },
});
const pending = (): Invitation => ({
  id: "c-1",
  consultantProfileId: "cp-guest",
  webinarPlanId: "plan-1",
  classPlanId: null,
  status: "PENDING",
  role: "CO_HOST",
  tier: "PRESENTER",
  revenueShareBps: 2500,
  acceptedAt: null,
  updatedAt: sentDaysAgo(2),
});

const world = {
  invitation: pending(),
  plan: { archivedAt: null as Date | null, consultantProfileId: "cp-host" },
  invitee: eligible(),
  seat: null as { id: string } | null,
  heldWindows: [] as Window[],
  windowsInTx: [] as Window[],
  clash: null as { id: string; startsAt?: Date; endsAt?: Date } | null,
  batchRefusal: null as Error | null,
};

function matches(where: Where): boolean {
  const { status, updatedAt, ...scalars } = where;
  const row: Record<string, unknown> = world.invitation;
  if (updatedAt && world.invitation.updatedAt < updatedAt.gte) return false;
  if (typeof status === "string" && row.status !== status) return false;
  if (
    typeof status === "object" &&
    !status.in.includes(world.invitation.status)
  )
    return false;
  return Object.entries(scalars).every(([key, value]) => row[key] === value);
}

const mockLock = jest.fn(
  async (_sql: TemplateStringsArray, ..._values: unknown[]) => 1,
);
const mockTx = {
  $queryRaw: mockLock,
  $executeRaw: mockLock,
  webinarPlan: { findUnique: jest.fn(async () => world.plan) },
  consultantProfile: { findUnique: jest.fn(async () => world.invitee) },
  appointmentParticipant: {
    findFirst: jest.fn(async () => world.seat),
    create: jest.fn(),
    createMany: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
    upsert: jest.fn(),
  },
  appointmentOccurrence: {
    findMany: jest.fn(async () => world.windowsInTx),
    findFirst: jest.fn(async () => world.clash),
  },
  collaborator: {
    updateMany: jest.fn(
      async ({ where, data }: Query & { data: Partial<Invitation> }) => {
        if (!matches(where)) return { count: 0 };
        Object.assign(world.invitation, data);
        return { count: 1 };
      },
    ),
    updateManyAndReturn: jest.fn(
      async ({ where, data }: Query & { data: Partial<Invitation> }) => {
        if (!matches(where)) return [];
        Object.assign(world.invitation, data);
        return [world.invitation];
      },
    ),
    findUniqueOrThrow: jest.fn(async () => world.invitation),
  },
};
const mockTransaction = jest.fn(
  async (run: (tx: unknown) => unknown, _opts?: unknown) => run(mockTx),
);
jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: {
    $transaction: (run: (tx: unknown) => unknown, opts?: unknown) =>
      mockTransaction(run, opts),
    collaborator: {
      findFirst: jest.fn(async ({ where }: Query) =>
        matches(where) ? world.invitation : null,
      ),
    },
    appointmentOccurrence: {
      findMany: jest.fn(async () => world.heldWindows),
    },
  },
}));

import {
  hostBatchEntries,
  HostTimeHeldError,
} from "@/lib/booking/host-slot-batch";
import { INVITE_TTL_DAYS, inviteLapsedBefore } from "@/lib/collaborators/rules";
import { respondToInvitation } from "@/lib/collaborators/service";

const seen = { role: "CO_HOST", sharePercent: 25 } as const;
const accept = (
  seenTerms: { role: "CO_HOST" | "MODERATOR"; sharePercent: number } = seen,
) =>
  respondToInvitation({
    collaboratorId: "c-1",
    consultantProfileId: "cp-guest",
    userId: "u-guest",
    response: "ACCEPTED",
    seenTerms,
  });
const decline = (consultantProfileId = "cp-guest") =>
  respondToInvitation({
    collaboratorId: "c-1",
    consultantProfileId,
    userId: "u-guest",
    response: "DECLINED",
  });

const participantWrites = () => {
  const { create, createMany, update, updateMany, upsert } =
    mockTx.appointmentParticipant;
  return [create, createMany, update, updateMany, upsert].flatMap(
    (write) => write.mock.calls,
  );
};
const statementOrder = () =>
  [mockLock, ...Object.values(mockTx).flatMap((m) => Object.values(m))].flatMap(
    (fn) => (jest.isMockFunction(fn) ? fn.mock.invocationCallOrder : []),
  );

beforeEach(() => {
  Object.assign(world, {
    invitation: pending(),
    plan: { archivedAt: null, consultantProfileId: "cp-host" },
    invitee: eligible(),
    seat: null,
    heldWindows: [session("appt-1", 10), session("appt-2", 14)],
    windowsInTx: [session("appt-1", 10), session("appt-2", 14)],
    clash: null,
    batchRefusal: null,
  });
  mockWithHostSlotBatch.mockImplementation(
    (_entries: unknown, run: (renew: () => Promise<void>) => unknown) =>
      world.batchRefusal
        ? Promise.reject(world.batchRefusal)
        : run(() => Promise.resolve()),
  );
});

describe("accepting an invitation", () => {
  it("joins the team with the seen terms, holding the calendar at every session, and grants access once after the commit", async () => {
    await expect(accept()).resolves.toEqual({
      id: "c-1",
      consultantProfileId: "cp-guest",
      role: "CO_HOST",
      tier: "PRESENTER",
      status: "ACCEPTED",
      revenueShareBps: 2500,
      planType: "webinar",
      planId: "plan-1",
    });

    // The write names the status and nothing else: Postgres stamps the period.
    expect(mockTx.collaborator.updateMany).toHaveBeenCalledWith({
      where: {
        id: "c-1",
        consultantProfileId: "cp-guest",
        status: "PENDING",
        role: "CO_HOST",
        revenueShareBps: 2500,
        updatedAt: { gte: expect.any(Date) },
      },
      data: { status: "ACCEPTED" },
    });
    expect(mockWithHostSlotBatch).toHaveBeenCalledWith(
      hostBatchEntries(["cp-guest"], world.heldWindows),
      expect.any(Function),
    );
    expect(mockTransaction).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ isolationLevel: "Serializable" }),
    );
    expect(mockLock.mock.invocationCallOrder[0]).toBe(
      Math.min(...statementOrder()),
    );
    expect(mockStageNotices).toHaveBeenCalledWith(
      mockTx,
      "ACCEPTED",
      expect.objectContaining({ id: "c-1" }),
    );
    expect(participantWrites()).toEqual([]);
    expect(mockGrant).toHaveBeenCalledTimes(1);
    expect(mockGrant).toHaveBeenCalledWith(
      { planType: "webinar", planId: "plan-1" },
      "u-guest",
    );
    expect(mockGrant.mock.invocationCallOrder[0]).toBeGreaterThan(
      Math.max(...statementOrder()),
    );
  });

  it("stages the seat holders' emails of the new co-presenter once the accept has committed", async () => {
    const owed = { collaboratorId: "c-1", userIds: ["u-l1"] };
    mockStageNotices.mockResolvedValueOnce({ learnerEmails: owed });
    const committed = jest.fn();
    mockTransaction.mockImplementationOnce(async (run) => {
      const result = await run(mockTx);
      committed();
      return result;
    });
    await accept();
    expect(mockSendOwed.mock.calls).toEqual([
      [[owed], "collaborator.accepted"],
    ]);
    expect(mockSendOwed.mock.invocationCallOrder[0]).toBeGreaterThan(
      committed.mock.invocationCallOrder[0],
    );
  });

  it.each([
    ["the role", { role: "MODERATOR", sharePercent: 25 } as const],
    ["the share", { role: "CO_HOST", sharePercent: 20 } as const],
  ])(
    "answers TERMS_CHANGED with the current terms when %s is not what the invitee saw",
    async (_name, seenTerms) => {
      await expect(accept(seenTerms)).rejects.toMatchObject({
        code: "TERMS_CHANGED",
        httpStatus: 409,
        detail: { terms: { role: "CO_HOST", sharePercent: 25 } },
      });
      expect(world.invitation.status).toBe("PENDING");
      expect(mockGrant).not.toHaveBeenCalled();
    },
  );

  it.each(["ACCEPTED", "DECLINED", "EXPIRED", "REMOVED"])(
    "answers NOT_PENDING for a row that is already %s",
    async (status) => {
      world.invitation.status = status;
      await expect(accept()).rejects.toMatchObject({ code: "NOT_PENDING" });
      expect(mockGrant).not.toHaveBeenCalled();
    },
  );

  it("refuses an invitation that lapsed fourteen days after it was last sent or changed, in the write that accepts", async () => {
    world.invitation.updatedAt = sentDaysAgo(INVITE_TTL_DAYS + 1);
    const before = Date.now();
    await expect(accept()).rejects.toMatchObject({
      code: "NOT_PENDING",
      httpStatus: 409,
      message: "This invitation has lapsed. Ask the host to invite you again.",
    });
    const [{ where }] = mockTx.collaborator.updateMany.mock.calls[0];
    const lapsedBefore = where.updatedAt?.gte.getTime() ?? NaN;
    expect(lapsedBefore).toBeGreaterThanOrEqual(
      inviteLapsedBefore(new Date(before)).getTime(),
    );
    expect(lapsedBefore).toBeLessThanOrEqual(
      inviteLapsedBefore(new Date()).getTime(),
    );
    expect(world.invitation.status).toBe("PENDING");
    expect(mockGrant).not.toHaveBeenCalled();
  });

  it("answers lapsed, not TERMS_CHANGED, for a lapsed invitation whose terms also differ", async () => {
    world.invitation.updatedAt = sentDaysAgo(INVITE_TTL_DAYS + 1);
    await expect(
      accept({ role: "MODERATOR", sharePercent: 25 }),
    ).rejects.toMatchObject({
      code: "NOT_PENDING",
      message: expect.stringMatching(/lapsed/),
    });
  });

  it("accepts an invitation on the last day of its window", async () => {
    world.invitation.updatedAt = sentDaysAgo(INVITE_TTL_DAYS - 1);
    await expect(accept()).resolves.toMatchObject({ status: "ACCEPTED" });
  });

  it("answers NOT_FOUND for an invitation addressed to another expert", async () => {
    world.invitation.consultantProfileId = "cp-other";
    await expect(accept()).rejects.toMatchObject({
      code: "NOT_FOUND",
      httpStatus: 404,
    });
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it.each([
    ["a session moved", [session("appt-1", 11), session("appt-2", 14)]],
    [
      "a session was added",
      [session("appt-1", 10), session("appt-2", 14), session("appt-3", 18)],
    ],
    ["a session was called off", [session("appt-1", 10)]],
  ])(
    "answers SCHEDULE_CHANGED when %s after the calendar was held",
    async (_name, windowsInTx) => {
      world.windowsInTx = windowsInTx;
      await expect(accept()).rejects.toMatchObject({
        code: "SCHEDULE_CHANGED",
        httpStatus: 409,
      });
      expect(mockTx.collaborator.updateMany).not.toHaveBeenCalled();
      expect(mockGrant).not.toHaveBeenCalled();
    },
  );

  it("answers CALENDAR_CLASH, never try-again copy, when a session overlaps the invitee's own calendar", async () => {
    world.clash = { id: "occ-elsewhere" };
    const refusal: unknown = await accept().catch((error: unknown) => error);
    expect(refusal).toMatchObject({ code: "CALENDAR_CLASH", httpStatus: 409 });
    expect((refusal as Error).message).not.toMatch(/right now|moment/);
    // The plan's own sessions are not a clash with themselves.
    expect(mockTx.appointmentOccurrence.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          appointmentId: { notIn: ["appt-1", "appt-2"] },
        }),
      }),
    );
    expect(mockTx.collaborator.updateMany).not.toHaveBeenCalled();
  });

  it("names the plan's session that clashed, and nothing of the commitment it met", async () => {
    // The invitee's other commitment overlaps the second session only.
    world.clash = {
      id: "occ-elsewhere",
      startsAt: new Date(at(14).getTime() + 30 * 60_000),
      endsAt: new Date(at(15).getTime() + 30 * 60_000),
    };
    const refusal: unknown = await accept().catch((error: unknown) => error);
    expect(refusal).toMatchObject({
      code: "CALENDAR_CLASH",
      detail: {
        clash: {
          startsAt: at(14).toISOString(),
          endsAt: at(15).toISOString(),
        },
      },
    });
    expect(Object.keys((refusal as { detail: object }).detail)).toEqual([
      "clash",
    ]);
  });

  it("answers CALENDAR_BUSY when another writer holds the invitee's time", async () => {
    world.batchRefusal = new HostTimeHeldError();
    await expect(accept()).rejects.toMatchObject({
      code: "CALENDAR_BUSY",
      httpStatus: 409,
      message: expect.stringMatching(/moment/),
    });
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it.each<[string, () => void, string]>([
    [
      "is non-resident on their profile",
      () => (world.invitee.residencyStatus = "NON_RESIDENT"),
      "NOT_PAYABLE",
    ],
    [
      "is non-resident on their tax record",
      () => (world.invitee.taxInfo = { isIndianResident: false }),
      "NOT_PAYABLE",
    ],
    [
      "deleted their profile",
      () => (world.invitee.deletedAt = new Date()),
      "INVITEE_INELIGIBLE",
    ],
    [
      "was erased",
      () => (world.invitee.user.erasedAt = new Date()),
      "INVITEE_INELIGIBLE",
    ],
    [
      "lost verification",
      () => (world.invitee.verificationStatus = "REJECTED"),
      "INVITEE_INELIGIBLE",
    ],
    [
      "is suspended",
      () => {
        world.invitee.user.banned = true;
        world.invitee.user.banExpires = new Date(Date.now() + DAY_MS);
      },
      "INVITEE_INELIGIBLE",
    ],
    [
      "booked a seat on the plan",
      () => (world.seat = { id: "s" }),
      "HOLDS_A_SEAT",
    ],
    [
      "answers after the plan was archived",
      () => (world.plan.archivedAt = new Date()),
      "PLAN_ARCHIVED",
    ],
  ])("refuses an invitee who %s", async (_name, arrange, code) => {
    arrange();
    await expect(accept()).rejects.toMatchObject({ code });
    expect(mockTx.collaborator.updateMany).not.toHaveBeenCalled();
    expect(mockGrant).not.toHaveBeenCalled();
  });

  it("lets an invitee through once their suspension has ended", async () => {
    world.invitee.user.banned = true;
    world.invitee.user.banExpires = new Date(Date.now() - DAY_MS);
    await expect(accept()).resolves.toMatchObject({ status: "ACCEPTED" });
  });

  it("replays a write conflict on a fresh attempt and answers CONFLICT once the attempts run out", async () => {
    const conflict = Object.assign(new Error("could not serialize"), {
      code: "P2034",
    });
    mockTransaction.mockRejectedValueOnce(conflict);
    await expect(accept()).resolves.toMatchObject({ status: "ACCEPTED" });
    expect(mockTransaction).toHaveBeenCalledTimes(2);
    expect(mockGrant).toHaveBeenCalledTimes(1);

    world.invitation = pending();
    mockTransaction.mockClear();
    mockGrant.mockClear();
    mockTransaction
      .mockRejectedValueOnce(conflict)
      .mockRejectedValueOnce(conflict)
      .mockRejectedValueOnce(conflict)
      .mockRejectedValueOnce(conflict);
    await expect(accept()).rejects.toMatchObject({
      code: "CONFLICT",
      httpStatus: 409,
    });
    expect(mockTransaction).toHaveBeenCalledTimes(4);
    expect(world.invitation.status).toBe("PENDING");
    expect(mockGrant).not.toHaveBeenCalled();
  });
});

describe("declining an invitation", () => {
  it("ends a pending row as DECLINED by the invitee, whatever the plan's state, and tells the host", async () => {
    world.plan.archivedAt = new Date();
    await expect(decline()).resolves.toMatchObject({
      id: "c-1",
      status: "DECLINED",
    });
    expect(mockTx.collaborator.updateManyAndReturn).toHaveBeenCalledWith({
      where: {
        consultantProfileId: "cp-guest",
        id: "c-1",
        status: { in: ["PENDING"] },
      },
      data: { status: "DECLINED", endedByUserId: "u-guest" },
    });
    expect(mockStageNotices).toHaveBeenCalledWith(
      mockTx,
      "DECLINED",
      expect.objectContaining({ id: "c-1" }),
      {},
    );
    expect(mockWithHostSlotBatch).not.toHaveBeenCalled();
    expect(mockGrant).not.toHaveBeenCalled();
  });

  it("declines an invitation that has lapsed and not yet been recorded as expired", async () => {
    world.invitation.updatedAt = sentDaysAgo(INVITE_TTL_DAYS + 1);
    await expect(decline()).resolves.toMatchObject({ status: "DECLINED" });
  });

  it("answers NOT_PENDING once the invitation is no longer open", async () => {
    world.invitation.status = "ACCEPTED";
    await expect(decline()).rejects.toMatchObject({
      code: "NOT_PENDING",
      httpStatus: 409,
    });
    expect(world.invitation.status).toBe("ACCEPTED");
    expect(mockStageNotices).not.toHaveBeenCalled();
  });
});
