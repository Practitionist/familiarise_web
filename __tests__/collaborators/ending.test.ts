/** @jest-environment node */

// Every way a collaboration ends goes through `endCollaboration`: the status
// change applies only from the statuses that ending allows, and someone who
// was on the team has the order to take their access back written with it.

const mockStageNotices = jest.fn();
const mockFlush = jest.fn();
const mockPersist = jest.fn();
const mockRevoke = jest.fn();
const mockReport = jest.fn();
const mockOutOfTime = jest.fn(() => false);
const reminderKey = (r: { id: string; updatedAt: Date }) =>
  `${r.id}:EXPIRING_SOON:${r.updatedAt.toISOString()}`;
jest.mock("@/lib/collaborators/notifications", () => ({
  INVITE_REMINDER_SCOPE: "collaborator.invite-expiring",
  inviteReminderKey: (r: { id: string; updatedAt: Date }) => reminderKey(r),
  stageCollaboratorNotifications: (...args: unknown[]) =>
    mockStageNotices(...args),
}));
jest.mock("@/lib/cron/run-deadline", () => ({
  startDeadlineShare: () => () => mockOutOfTime(),
}));
jest.mock("@/lib/novu/stage-then-attempt", () => ({
  flushNotificationsAfter: (...args: unknown[]) => mockFlush(...args),
}));
jest.mock("@/lib/observability/report", () => ({
  reportSentryError: (...args: unknown[]) => mockReport(...args),
}));
jest.mock("@/lib/stream/access-revocation", () => ({
  persistCollaboratorRevocationInTx: (...args: unknown[]) =>
    mockPersist(...args),
  revokeCollaboratorAccess: (...args: unknown[]) => mockRevoke(...args),
}));
jest.mock("@/lib/stream/collaborator-access", () => ({
  grantCollaboratorAccess: jest.fn(),
}));
jest.mock("@/lib/booking/host-slot-batch", () => ({
  HostTimeHeldError: class HostTimeHeldError extends Error {},
  hostBatchEntries: jest.fn(),
  withHostSlotBatch: jest.fn(),
}));
jest.mock("@/lib/cron/with-cron-lock", () => ({
  withCronLock: (_name: string, _opts: unknown, run: () => unknown) => run(),
}));

type Row = {
  id: string;
  consultantProfileId: string;
  webinarPlanId: string | null;
  classPlanId: string | null;
  status: string;
  acceptedAt: Date | null;
  updatedAt: Date;
  endedByUserId: string | null;
};
type Where = {
  id?: string;
  consultantProfileId?: string;
  webinarPlanId?: string;
  status?: string | { in: string[] };
  updatedAt?: Date | { lt: Date; gte?: Date };
  consultantProfile?: { userId: string };
};
type Write = { where: Where; data: Partial<Row> };

const DAY_MS = 86_400_000;
const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS);
const GENERATION = new Date("2027-01-12T10:00:00Z");
const USER_OF: Record<string, string> = {
  "cp-guest": "u-guest",
  "cp-other": "u-other",
};

let rows: Row[] = [];
/** The reminders already claimed, by key. */
let reminded: Set<string> = new Set();
const row = (over: Partial<Row> = {}): Row => ({
  id: "c-1",
  consultantProfileId: "cp-guest",
  webinarPlanId: "plan-1",
  classPlanId: null,
  status: "PENDING",
  acceptedAt: null,
  updatedAt: daysAgo(1),
  endedByUserId: null,
  ...over,
});
const onTeam = (over: Partial<Row> = {}) =>
  row({ status: "ACCEPTED", acceptedAt: daysAgo(3), ...over });

function matches(r: Row, where: Where): boolean {
  const { status, updatedAt, consultantProfile } = where;
  if (typeof status === "string" && r.status !== status) return false;
  if (typeof status === "object" && !status.in.includes(r.status)) return false;
  if (updatedAt instanceof Date) {
    if (r.updatedAt.getTime() !== updatedAt.getTime()) return false;
  } else if (updatedAt) {
    if (!(r.updatedAt < updatedAt.lt)) return false;
    if (updatedAt.gte && r.updatedAt < updatedAt.gte) return false;
  }
  if (
    consultantProfile &&
    USER_OF[r.consultantProfileId] !== consultantProfile.userId
  ) {
    return false;
  }
  return (
    (where.id === undefined || r.id === where.id) &&
    (where.consultantProfileId === undefined ||
      r.consultantProfileId === where.consultantProfileId) &&
    (where.webinarPlanId === undefined ||
      r.webinarPlanId === where.webinarPlanId)
  );
}

const mockTx = {
  collaborator: {
    findMany: jest.fn(async ({ where }: { where: Where }) =>
      rows
        .filter((r) => matches(r, where))
        .map(({ id, updatedAt }) => ({ id, updatedAt })),
    ),
    findFirst: jest.fn(
      async ({ where }: { where: Where }) =>
        rows.find((r) => matches(r, where)) ?? null,
    ),
    updateManyAndReturn: jest.fn(async ({ where, data }: Write) => {
      const hit = rows.filter((r) => matches(r, where));
      hit.forEach((r) => Object.assign(r, data));
      return hit;
    }),
  },
  consultantProfile: {
    findUnique: jest.fn(async ({ where }: { where: { id: string } }) => ({
      userId: USER_OF[where.id],
    })),
  },
};
const mockTransaction = jest.fn((run: (tx: unknown) => unknown) => run(mockTx));
jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: {
    $transaction: (run: (tx: unknown) => unknown) => mockTransaction(run),
    get collaborator() {
      return mockTx.collaborator;
    },
    idempotencyRecord: {
      findMany: async ({ where }: { where: { key: { in: string[] } } }) =>
        where.key.in.filter((key) => reminded.has(key)).map((key) => ({ key })),
    },
  },
}));

import { expireStaleCollaboratorInvites } from "@/lib/collaborators/cleanup";
import {
  afterCollaborationEnded,
  endCollaboration,
  endCollaborationsForUser,
  type CollaborationEnding,
  type EndedCollaboration,
} from "@/lib/collaborators/ending";
import {
  leaveCollaboration,
  removeCollaborator,
} from "@/lib/collaborators/service";
import type { Tx } from "@/lib/prisma";

const tx = mockTx as unknown as Tx;
const ref = { planType: "webinar", planId: "plan-1" } as const;
const STATUSES = [
  "PENDING",
  "ACCEPTED",
  "DECLINED",
  "EXPIRED",
  "REMOVED",
  "WITHDRAWN",
];

beforeEach(() => {
  rows = [];
  reminded = new Set();
  mockOutOfTime.mockReturnValue(false);
  mockStageNotices.mockImplementation(async (_tx, event: string, r: Row) => {
    if (event === "EXPIRING_SOON") reminded.add(reminderKey(r));
    return {
      bells: [{ id: `bell:${r.id}:${event}` }],
      emails: [{ list: [{ id: `mail:${r.id}` }], emailType: event }],
    };
  });
  mockFlush.mockResolvedValue(undefined);
  mockPersist.mockResolvedValue(GENERATION);
  mockRevoke.mockResolvedValue(undefined);
});

describe("endCollaboration", () => {
  it.each<[CollaborationEnding, string[]]>([
    ["DECLINED", ["PENDING"]],
    ["EXPIRED", ["PENDING"]],
    ["WITHDRAWN", ["ACCEPTED"]],
    ["REMOVED", ["PENDING", "ACCEPTED"]],
  ])("%s applies only from %j", async (to, from) => {
    const applied: string[] = [];
    for (const status of STATUSES) {
      rows = [row({ status })];
      const ended = await endCollaboration(tx, {
        collaboratorId: "c-1",
        to,
        endedByUserId: "u-actor",
      });
      if (ended) applied.push(status);
      expect(rows[0].status).toBe(ended ? to : status);
    }
    expect(applied).toEqual(from);
    // One guarded statement that names the status and the actor, nothing else.
    expect(mockTx.collaborator.updateManyAndReturn).toHaveBeenLastCalledWith({
      where: { id: "c-1", status: { in: from } },
      data: { status: to, endedByUserId: "u-actor" },
    });
  });

  it("applies the caller's further conditions in the same guarded write", async () => {
    rows = [row()];
    await expect(
      endCollaboration(tx, {
        collaboratorId: "c-1",
        to: "REMOVED",
        endedByUserId: null,
        where: { consultantProfileId: "cp-other" },
      }),
    ).resolves.toBeNull();
    expect(rows[0].status).toBe("PENDING");
    expect(mockStageNotices).not.toHaveBeenCalled();
    expect(mockPersist).not.toHaveBeenCalled();
  });

  it("writes the revocation in the same transaction for someone who was on the team", async () => {
    rows = [onTeam()];
    await expect(
      endCollaboration(tx, {
        collaboratorId: "c-1",
        to: "REMOVED",
        endedByUserId: "u-host",
      }),
    ).resolves.toMatchObject({
      ref,
      userId: "u-guest",
      wasOnTeam: true,
      revocationGeneration: GENERATION,
      notices: { bells: [{ id: "bell:c-1:REMOVED" }] },
    });
    expect(mockPersist).toHaveBeenCalledTimes(1);
    expect(mockPersist).toHaveBeenCalledWith(tx, ref, "u-guest");
    expect(mockStageNotices).toHaveBeenCalledWith(tx, "REMOVED", rows[0], {});
  });

  it("writes no revocation for an invitation, which never held access", async () => {
    rows = [row()];
    await expect(
      endCollaboration(tx, {
        collaboratorId: "c-1",
        to: "DECLINED",
        endedByUserId: "u-guest",
      }),
    ).resolves.toMatchObject({ wasOnTeam: false, revocationGeneration: null });
    expect(mockPersist).not.toHaveBeenCalled();
  });

  it("writes none when the caller keeps a revocation queue of its own", async () => {
    rows = [onTeam()];
    await expect(
      endCollaboration(tx, {
        collaboratorId: "c-1",
        to: "REMOVED",
        endedByUserId: null,
        ownRevocationQueue: true,
      }),
    ).resolves.toMatchObject({ wasOnTeam: true, revocationGeneration: null });
    expect(mockPersist).not.toHaveBeenCalled();
  });

  it("stages the notice the caller names, without the collaborator's name when asked", async () => {
    rows = [onTeam()];
    await endCollaboration(tx, {
      collaboratorId: "c-1",
      to: "REMOVED",
      endedByUserId: null,
      notice: { event: "WITHDRAWN", anonymous: true },
    });
    expect(mockStageNotices).toHaveBeenCalledWith(tx, "WITHDRAWN", rows[0], {
      collaboratorName: "A collaborator",
    });
  });
});

describe("endCollaborationsForUser", () => {
  it("ends the user's invitations and team places as REMOVED and stages the unnamed left-the-plan notice", async () => {
    rows = [
      row({ id: "c-1" }),
      onTeam({ id: "c-2", webinarPlanId: null, classPlanId: "class-9" }),
      row({ id: "c-3", status: "DECLINED" }),
      onTeam({ id: "c-4", consultantProfileId: "cp-other" }),
    ];

    const ended = await endCollaborationsForUser(tx, "u-guest", {
      endedByUserId: "u-staff",
    });

    expect(mockTx.collaborator.findMany).toHaveBeenCalledWith({
      where: {
        consultantProfile: { userId: "u-guest" },
        status: { in: ["PENDING", "ACCEPTED"] },
      },
      select: { id: true },
      orderBy: { id: "asc" },
    });
    expect(rows.map((r) => [r.status, r.endedByUserId])).toEqual([
      ["REMOVED", "u-staff"],
      ["REMOVED", "u-staff"],
      ["DECLINED", null],
      ["ACCEPTED", null],
    ]);
    expect(ended.map((e) => [e.collaborator.id, e.wasOnTeam, e.ref])).toEqual([
      ["c-1", false, ref],
      ["c-2", true, { planType: "class", planId: "class-9" }],
    ]);
    expect(mockPersist).toHaveBeenCalledTimes(1);
    expect(
      mockStageNotices.mock.calls.map(([, event, , opts]) => [event, opts]),
    ).toEqual([
      ["WITHDRAWN", { collaboratorName: "A collaborator" }],
      ["WITHDRAWN", { collaboratorName: "A collaborator" }],
    ]);
  });
});

describe("afterCollaborationEnded", () => {
  const ended = (id: string, generation: Date | null): EndedCollaboration => ({
    collaborator: { id } as EndedCollaboration["collaborator"],
    ref,
    userId: `u-${id}`,
    wasOnTeam: generation !== null,
    revocationGeneration: generation,
    notices: { bells: [{ id: `bell:${id}` }] as never, emails: [] },
  });

  it("flushes every notice once and takes access back only where a revocation was written", async () => {
    await afterCollaborationEnded(
      [ended("a", GENERATION), ended("b", null)],
      "test.op",
    );
    expect(mockFlush).toHaveBeenCalledTimes(1);
    expect(mockFlush).toHaveBeenCalledWith(
      { bells: [{ id: "bell:a" }, { id: "bell:b" }], emails: [] },
      "test.op",
    );
    expect(mockRevoke.mock.calls).toEqual([[ref, "u-a", GENERATION]]);
  });

  it("does nothing for an empty list", async () => {
    await afterCollaborationEnded([], "test.op");
    expect(mockFlush).not.toHaveBeenCalled();
    expect(mockRevoke).not.toHaveBeenCalled();
  });

  it.each([
    ["the notices", () => mockFlush.mockRejectedValueOnce(new Error("novu"))],
    [
      "the revocation",
      () => mockRevoke.mockRejectedValueOnce(new Error("stream")),
    ],
  ])("never throws when %s fail; it reports once", async (_name, arrange) => {
    arrange();
    await expect(
      afterCollaborationEnded(ended("a", GENERATION), "test.op"),
    ).resolves.toBeUndefined();
    expect(mockReport).toHaveBeenCalledTimes(1);
    expect(mockReport).toHaveBeenCalledWith(expect.any(Error), {
      subsystem: "collaborators",
      op: "test.op.afterEnded",
      extra: { collaboratorIds: ["a"] },
    });
  });
});

describe("leaving and removing through the service", () => {
  const leave = (consultantProfileId = "cp-guest") =>
    leaveCollaboration({
      ref,
      collaboratorId: "c-1",
      consultantProfileId,
      userId: "u-guest",
    });
  const remove = (planId = "plan-1") =>
    removeCollaborator({
      ref: { planType: "webinar", planId },
      collaboratorId: "c-1",
      removedByUserId: "u-host",
    });

  it("records WITHDRAWN when a team member leaves, with the revocation, and takes access back after the commit", async () => {
    rows = [onTeam()];
    await expect(leave()).resolves.toMatchObject({
      id: "c-1",
      status: "WITHDRAWN",
      planId: "plan-1",
    });
    expect(rows[0].endedByUserId).toBe("u-guest");
    expect(mockPersist).toHaveBeenCalledWith(tx, ref, "u-guest");
    expect(mockStageNotices).toHaveBeenCalledWith(tx, "WITHDRAWN", rows[0], {});
    expect(mockRevoke).toHaveBeenCalledWith(ref, "u-guest", GENERATION);
    expect(mockTransaction).toHaveBeenCalledTimes(1);
  });

  it("records DECLINED when an invitee turns down an invitation they never accepted", async () => {
    rows = [row()];
    await expect(leave()).resolves.toMatchObject({ status: "DECLINED" });
    expect(mockPersist).not.toHaveBeenCalled();
    expect(mockRevoke).not.toHaveBeenCalled();
    expect(mockStageNotices).toHaveBeenCalledWith(tx, "DECLINED", rows[0], {});
  });

  it.each<[string, () => Row[], () => Promise<unknown>]>([
    ["someone else's row", () => [onTeam()], () => leave("cp-other")],
    [
      "a row that already ended",
      () => [row({ status: "REMOVED" })],
      () => leave(),
    ],
    [
      "a manager's removal on another plan",
      () => [onTeam()],
      () => remove("plan-2"),
    ],
    [
      "a manager's removal of an ended row",
      () => [row({ status: "WITHDRAWN" })],
      () => remove(),
    ],
  ])(
    "answers NOT_FOUND and changes nothing for %s",
    async (_name, seed, act) => {
      rows = seed();
      const before = rows[0].status;
      await expect(act()).rejects.toMatchObject({
        code: "NOT_FOUND",
        httpStatus: 404,
      });
      expect(rows[0].status).toBe(before);
      expect(mockStageNotices).not.toHaveBeenCalled();
      expect(mockFlush).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["an invitation", () => row(), 0],
    ["a team member", () => onTeam(), 1],
  ])("a manager removes %s as REMOVED", async (_name, seed, revocations) => {
    rows = [seed()];
    await expect(remove()).resolves.toMatchObject({ status: "REMOVED" });
    expect(rows[0].endedByUserId).toBe("u-host");
    expect(mockTx.collaborator.updateManyAndReturn).toHaveBeenCalledWith({
      where: {
        webinarPlanId: "plan-1",
        id: "c-1",
        status: { in: ["PENDING", "ACCEPTED"] },
      },
      data: { status: "REMOVED", endedByUserId: "u-host" },
    });
    expect(mockPersist).toHaveBeenCalledTimes(revocations);
    expect(mockRevoke).toHaveBeenCalledTimes(revocations);
  });
});

describe("the invitation expiry sweep", () => {
  it("ends a lapsed invitation as EXPIRED and leaves alone one edited since the cutoff", async () => {
    rows = [
      row({ id: "lapsed", updatedAt: daysAgo(15) }),
      row({ id: "fresh", updatedAt: daysAgo(5) }),
      onTeam({ id: "member", updatedAt: daysAgo(40) }),
    ];
    // The invitee's terms were changed after the sweep listed the row.
    mockTx.collaborator.findMany.mockResolvedValueOnce([
      { id: "lapsed" },
      { id: "fresh" },
    ]);

    await expect(expireStaleCollaboratorInvites()).resolves.toEqual({
      expired: 1,
      reminded: 0,
      scanned: 2,
      failed: 0,
      hasMore: false,
    });

    expect(rows.map((r) => r.status)).toEqual([
      "EXPIRED",
      "PENDING",
      "ACCEPTED",
    ]);
    const [{ where, data }] =
      mockTx.collaborator.updateManyAndReturn.mock.calls[0];
    expect(where).toEqual({
      updatedAt: { lt: expect.any(Date) },
      id: "lapsed",
      status: { in: ["PENDING"] },
    });
    const cutoffAgeDays = (Date.now() - where.updatedAt!.lt.getTime()) / DAY_MS;
    expect(cutoffAgeDays).toBeCloseTo(14, 3);
    expect(data).toEqual({ status: "EXPIRED", endedByUserId: null });
    expect(mockStageNotices.mock.calls.map(([, event]) => event)).toEqual([
      "EXPIRED",
    ]);
    expect(mockPersist).not.toHaveBeenCalled();
    expect(mockFlush).toHaveBeenCalledTimes(1);
    expect(mockReport).not.toHaveBeenCalled();
  });

  it("lists only pending rows older than the invitation window, oldest first", async () => {
    await expireStaleCollaboratorInvites(500);
    expect(mockTx.collaborator.findMany).toHaveBeenCalledWith({
      where: { status: "PENDING", updatedAt: { lt: expect.any(Date) } },
      take: 50,
      orderBy: { updatedAt: "asc" },
      select: { id: true },
    });
  });

  it("collects failures and reports them once, and still expires the rest", async () => {
    rows = ["a", "b", "c"].map((id) => row({ id, updatedAt: daysAgo(20) }));
    mockTx.collaborator.updateManyAndReturn
      .mockRejectedValueOnce(new Error("first failure"))
      .mockRejectedValueOnce(new Error("second failure"));

    await expect(expireStaleCollaboratorInvites()).resolves.toEqual({
      expired: 1,
      reminded: 0,
      scanned: 3,
      failed: 2,
      hasMore: false,
    });

    expect(rows.map((r) => r.status)).toEqual([
      "PENDING",
      "PENDING",
      "EXPIRED",
    ]);
    expect(mockReport).toHaveBeenCalledTimes(1);
    expect(mockReport).toHaveBeenCalledWith(
      expect.objectContaining({ message: "first failure" }),
      {
        subsystem: "collaborators",
        op: "expireStaleCollaboratorInvites",
        extra: { failed: 2, scanned: 3, collaboratorIds: ["a", "b"] },
      },
    );
  });
  it("reminds an invitee once, three days before the invitation lapses, and a second run does nothing", async () => {
    rows = [
      row({ id: "soon", updatedAt: daysAgo(12) }),
      row({ id: "early", updatedAt: daysAgo(5) }),
      onTeam({ id: "member", updatedAt: daysAgo(12) }),
    ];

    await expect(expireStaleCollaboratorInvites()).resolves.toMatchObject({
      expired: 0,
      reminded: 1,
      scanned: 1,
    });
    expect(mockStageNotices).toHaveBeenCalledTimes(1);
    expect(mockStageNotices).toHaveBeenCalledWith(
      mockTx,
      "EXPIRING_SOON",
      expect.objectContaining({ id: "soon" }),
    );
    expect(rows[0].status).toBe("PENDING");

    await expect(expireStaleCollaboratorInvites()).resolves.toMatchObject({
      reminded: 0,
      scanned: 0,
    });
    expect(mockStageNotices).toHaveBeenCalledTimes(1);

    // New terms restart the window, so the invitation is reminded again.
    rows[0].updatedAt = daysAgo(11.5);
    await expect(expireStaleCollaboratorInvites()).resolves.toMatchObject({
      reminded: 1,
    });
  });

  it("starts no row past its time budget, leaves the rest for the next run and reports once", async () => {
    rows = [
      ...["a", "b", "c"].map((id) => row({ id, updatedAt: daysAgo(20) })),
      row({ id: "soon", updatedAt: daysAgo(12) }),
    ];
    mockOutOfTime
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false)
      .mockReturnValue(true);
    mockTx.collaborator.updateManyAndReturn.mockRejectedValueOnce(
      new Error("first failure"),
    );

    await expect(expireStaleCollaboratorInvites()).resolves.toEqual({
      expired: 1,
      reminded: 0,
      scanned: 3,
      failed: 1,
      hasMore: true,
    });
    expect(rows.map((r) => r.status)).toEqual([
      "PENDING",
      "EXPIRED",
      "PENDING",
      "PENDING",
    ]);
    expect(mockReport).toHaveBeenCalledTimes(1);
  });
});
