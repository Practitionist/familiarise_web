/** @jest-environment node */

// Inviting an expert and editing a pending invitation's terms, through the
// real service over a small in-memory team.

const mockStageNotices = jest.fn(async (..._args: unknown[]) => ({}));
const mockFlush = jest.fn(async (..._args: unknown[]) => undefined);
jest.mock("@/lib/collaborators/notifications", () => ({
  stageCollaboratorNotifications: (...args: unknown[]) =>
    mockStageNotices(...args),
}));
jest.mock("@/lib/novu/stage-then-attempt", () => ({
  flushNotificationsAfter: (...args: unknown[]) => mockFlush(...args),
}));
jest.mock("@/lib/observability/report", () => ({
  reportSentryError: jest.fn(),
}));
jest.mock("@/lib/stream/collaborator-access", () => ({
  grantCollaboratorAccess: jest.fn(),
}));
jest.mock("@/lib/stream/access-revocation", () => ({
  persistCollaboratorRevocationInTx: jest.fn(),
  revokeCollaboratorAccess: jest.fn(),
}));
jest.mock("@/lib/booking/host-slot-batch", () => ({
  HostTimeHeldError: class HostTimeHeldError extends Error {},
  hostBatchEntries: jest.fn(),
  withHostSlotBatch: jest.fn(),
}));

type Row = {
  id: string;
  consultantProfileId: string;
  webinarPlanId: string;
  status: string;
  role: string;
  revenueShareBps: number;
  endedAt: Date | null;
};
type Where = {
  id?: string | { not: string };
  consultantProfileId?: string;
  webinarPlanId?: string;
  status?: string | { in: string[] };
};
type Query = { where: Where };

const DAY_MS = 86_400_000;
const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS);

const eligible = () => ({
  deletedAt: null as Date | null,
  verificationStatus: "VERIFIED",
  residencyStatus: "RESIDENT",
  taxInfo: { isIndianResident: true } as { isIndianResident: boolean } | null,
  user: {
    id: "u-guest",
    banned: false as boolean | null,
    banExpires: null as Date | null,
    erasedAt: null as Date | null,
  },
});

const world = {
  plan: { archivedAt: null as Date | null, consultantProfileId: "cp-host" } as {
    archivedAt: Date | null;
    consultantProfileId: string | null;
  } | null,
  invitee: eligible() as ReturnType<typeof eligible> | null,
  seat: null as { id: string } | null,
  rows: [] as Row[],
};

const row = (over: Partial<Row>): Row => ({
  id: "c-1",
  consultantProfileId: "cp-other",
  webinarPlanId: "plan-1",
  status: "PENDING",
  role: "MODERATOR",
  revenueShareBps: 1000,
  endedAt: null,
  ...over,
});

function matches(r: Row, where: Where): boolean {
  const { id, status } = where;
  if (typeof id === "string" && r.id !== id) return false;
  if (typeof id === "object" && r.id === id.not) return false;
  if (typeof status === "string" && r.status !== status) return false;
  if (typeof status === "object" && !status.in.includes(r.status)) return false;
  if (
    where.consultantProfileId !== undefined &&
    r.consultantProfileId !== where.consultantProfileId
  ) {
    return false;
  }
  return (
    where.webinarPlanId === undefined || r.webinarPlanId === where.webinarPlanId
  );
}

const mockLock = jest.fn(
  async (_sql: TemplateStringsArray, ..._values: unknown[]) => 1,
);
const mockTx = {
  $queryRaw: mockLock,
  $executeRaw: mockLock,
  webinarPlan: { findUnique: jest.fn(async () => world.plan) },
  consultantProfile: { findUnique: jest.fn(async () => world.invitee) },
  appointmentParticipant: { findFirst: jest.fn(async () => world.seat) },
  collaborator: {
    findMany: jest.fn(async ({ where }: Query) =>
      world.rows.filter((r) => matches(r, where)),
    ),
    findFirst: jest.fn(
      async ({ where }: Query) =>
        world.rows.find((r) => matches(r, where)) ?? null,
    ),
    findUniqueOrThrow: jest.fn(async ({ where }: Query) =>
      world.rows.find((r) => matches(r, where)),
    ),
    create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
      id: "c-new",
      ...data,
    })),
    update: jest.fn(),
    updateMany: jest.fn(
      async ({ where, data }: Query & { data: Partial<Row> }) => {
        const hit = world.rows.filter((r) => matches(r, where));
        hit.forEach((r) => Object.assign(r, data));
        return { count: hit.length };
      },
    ),
  },
};
jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: {
    $transaction: (run: (tx: unknown) => unknown) => run(mockTx),
  },
}));

import {
  inviteCollaborator,
  updatePendingTerms,
} from "@/lib/collaborators/service";

const ref = { planType: "webinar", planId: "plan-1" } as const;
const invite = (over: Partial<Parameters<typeof inviteCollaborator>[0]> = {}) =>
  inviteCollaborator({
    ref,
    consultantProfileId: "cp-guest",
    role: "MODERATOR",
    sharePercent: 5,
    invitedByProfileId: "cp-host",
    ...over,
  });
const edit = (terms: {
  role?: "CO_HOST" | "MODERATOR";
  sharePercent?: number;
}) => updatePendingTerms({ ref, collaboratorId: "c-1", ...terms });

/** The global order of every statement the transaction ran. */
const statementOrder = () =>
  [mockLock, ...Object.values(mockTx).flatMap((m) => Object.values(m))].flatMap(
    (fn) => (jest.isMockFunction(fn) ? fn.mock.invocationCallOrder : []),
  );

beforeEach(() => {
  world.plan = { archivedAt: null, consultantProfileId: "cp-host" };
  world.invitee = eligible();
  world.seat = null;
  world.rows = [];
});

describe("inviting a collaborator", () => {
  it("creates a new pending row beside the expert's ended one and stages the invited notice", async () => {
    world.rows = [
      row({
        consultantProfileId: "cp-guest",
        status: "REMOVED",
        endedAt: daysAgo(1),
      }),
    ];

    await expect(
      invite({ role: "CO_HOST", sharePercent: 25 }),
    ).resolves.toEqual({
      id: "c-new",
      consultantProfileId: "cp-guest",
      role: "CO_HOST",
      tier: "PRESENTER",
      status: "PENDING",
      revenueShareBps: 2500,
      planType: "webinar",
      planId: "plan-1",
    });

    expect(mockTx.collaborator.create).toHaveBeenCalledWith({
      data: {
        consultantProfileId: "cp-guest",
        collaboratorType: "WEBINAR",
        webinarPlanId: "plan-1",
        role: "CO_HOST",
        tier: "PRESENTER",
        revenueShareBps: 2500,
        status: "PENDING",
        invitedById: "cp-host",
      },
    });
    expect(mockTx.collaborator.update).not.toHaveBeenCalled();
    expect(mockTx.collaborator.updateMany).not.toHaveBeenCalled();
    expect(world.rows[0].status).toBe("REMOVED");
    expect(mockStageNotices).toHaveBeenCalledWith(
      mockTx,
      "INVITED",
      expect.objectContaining({ id: "c-new" }),
    );
  });

  it("locks the plan row before any other statement of the transaction", async () => {
    await invite();
    const [sql, ...values] = mockLock.mock.calls[0];
    expect(sql.join("?")).toContain('"WebinarPlan"');
    expect(values).toEqual(["plan-1"]);
    expect(mockLock.mock.invocationCallOrder[0]).toBe(
      Math.min(...statementOrder()),
    );
  });

  it.each(["PENDING", "ACCEPTED"])(
    "refuses an expert who already holds a %s row on the plan",
    async (status) => {
      world.rows = [row({ consultantProfileId: "cp-guest", status })];
      await expect(invite()).rejects.toMatchObject({
        code: "ALREADY_ON_PLAN",
        httpStatus: 409,
      });
      expect(mockTx.collaborator.create).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["DECLINED", 6],
    ["WITHDRAWN", 1],
  ])(
    "waits out the cooldown after a %s row ended %i days ago and says when it ends",
    async (status, days) => {
      const endedAt = daysAgo(days);
      world.rows = [row({ consultantProfileId: "cp-guest", status, endedAt })];
      await expect(invite()).rejects.toMatchObject({
        code: "COOLDOWN",
        detail: {
          retryAt: new Date(endedAt.getTime() + 7 * DAY_MS).toISOString(),
        },
      });
      expect(mockTx.collaborator.create).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["DECLINED", 8],
    ["EXPIRED", 1],
    ["REMOVED", 1],
  ])(
    "invites again at once after a %s row ended %i days ago",
    async (status, days) => {
      world.rows = [
        row({
          consultantProfileId: "cp-guest",
          status,
          endedAt: daysAgo(days),
        }),
      ];
      await expect(invite()).resolves.toMatchObject({ status: "PENDING" });
    },
  );

  it.each([
    [
      "a fourth invited or accepted collaborator",
      [
        row({ id: "a", role: "CO_HOST", status: "ACCEPTED" }),
        row({ id: "b" }),
        row({ id: "c", role: "TECHNICAL_SUPPORT" }),
      ],
      { role: "GUEST_SPEAKER" } as const,
      { code: "TEAM_FULL" },
    ],
    [
      "a second presenter",
      [row({ role: "CO_HOST" })],
      { role: "CO_HOST" } as const,
      { code: "PRESENTER_TAKEN" },
    ],
    [
      "shares past nine tenths, naming what is left",
      [
        row({ id: "a", revenueShareBps: 5000, status: "ACCEPTED" }),
        row({ id: "b", revenueShareBps: 3500 }),
      ],
      { sharePercent: 6 },
      { code: "SHARES_EXCEEDED", detail: { availablePercent: 5 } },
    ],
  ])("refuses %s", async (_name, rows, terms, refusal) => {
    world.rows = rows;
    await expect(invite(terms)).rejects.toMatchObject({
      ...refusal,
      httpStatus: 409,
    });
    expect(mockTx.collaborator.create).not.toHaveBeenCalled();
  });

  it("allows a crew role beside the one presenter, up to the last percent", async () => {
    world.rows = [row({ role: "CO_HOST", revenueShareBps: 8500 })];
    await expect(invite({ sharePercent: 5 })).resolves.toMatchObject({
      role: "MODERATOR",
      revenueShareBps: 500,
    });
  });

  it.each<[string, () => void]>([
    ["has no profile", () => (world.invitee = null)],
    ["deleted their profile", () => (world.invitee!.deletedAt = new Date())],
    ["was erased", () => (world.invitee!.user.erasedAt = new Date())],
    [
      "is not verified",
      () => (world.invitee!.verificationStatus = "UNDER_REVIEW"),
    ],
    ["is under a ban with no end", () => (world.invitee!.user.banned = true)],
    [
      "is under a suspension that has not ended",
      () => {
        world.invitee!.user.banned = true;
        world.invitee!.user.banExpires = new Date(Date.now() + DAY_MS);
      },
    ],
    [
      "is non-resident on their profile",
      () => (world.invitee!.residencyStatus = "NON_RESIDENT"),
    ],
    [
      "is non-resident on their tax record",
      () => (world.invitee!.taxInfo = { isIndianResident: false }),
    ],
  ])(
    "answers the one generic sentence when the invitee %s",
    async (_name, arrange) => {
      arrange();
      await expect(invite()).rejects.toMatchObject({
        code: "INVITEE_INELIGIBLE",
        httpStatus: 400,
        message: "This expert cannot be invited right now.",
        detail: undefined,
      });
      expect(mockTx.collaborator.create).not.toHaveBeenCalled();
    },
  );

  it("treats an expired ban as no ban and a missing tax record as resident", async () => {
    world.invitee!.user.banned = true;
    world.invitee!.user.banExpires = daysAgo(1);
    world.invitee!.taxInfo = null;
    await expect(invite()).resolves.toMatchObject({ status: "PENDING" });
  });

  it.each<[string, () => void, object, string]>([
    ["HOLDS_A_SEAT", () => (world.seat = { id: "seat-1" }), {}, "cp-guest"],
    [
      "PLAN_ARCHIVED",
      () => (world.plan!.archivedAt = new Date()),
      {},
      "cp-guest",
    ],
    ["NOT_FOUND", () => (world.plan = null), {}, "cp-guest"],
    ["INVITEE_INELIGIBLE", () => undefined, {}, "cp-host"],
    [
      "INVITEE_INELIGIBLE",
      () => undefined,
      { invitedByProfileId: "cp-operator" },
      "cp-operator",
    ],
  ])(
    "refuses with %s (case %#)",
    async (code, arrange, over, consultantProfileId) => {
      arrange();
      await expect(
        invite({ ...over, consultantProfileId }),
      ).rejects.toMatchObject({ code });
      expect(mockTx.collaborator.create).not.toHaveBeenCalled();
    },
  );

  it.each<[string, object]>([
    ["a class role on a webinar", { role: "CO_INSTRUCTOR" }],
    ["a fractional share", { sharePercent: 2.5 }],
    ["a share above ninety", { sharePercent: 91 }],
  ])("refuses %s before opening a transaction", async (_name, terms) => {
    await expect(invite(terms)).rejects.toMatchObject({
      code: "INVALID_TERMS",
      httpStatus: 400,
    });
    expect(mockLock).not.toHaveBeenCalled();
  });

  it.each([
    ["a unique violation", { code: "P2002" }, "ALREADY_ON_PLAN"],
    ["SQLSTATE 23514", { meta: { code: "23514" } }, "CONFLICT"],
  ])(
    "maps %s from Postgres to a refusal the screen can act on",
    async (_name, fault, code) => {
      mockTx.collaborator.create.mockRejectedValueOnce(
        Object.assign(new Error("refused by Postgres"), fault),
      );
      await expect(invite()).rejects.toMatchObject({ code, httpStatus: 409 });
      expect(mockFlush).not.toHaveBeenCalled();
    },
  );
});

describe("editing a pending invitation's terms", () => {
  it("refuses an accepted row as TERMS_LOCKED and writes nothing", async () => {
    world.rows = [row({ status: "ACCEPTED" })];
    await expect(edit({ sharePercent: 20 })).rejects.toMatchObject({
      code: "TERMS_LOCKED",
      httpStatus: 409,
    });
    expect(mockTx.collaborator.updateMany).not.toHaveBeenCalled();
    expect(world.rows[0].revenueShareBps).toBe(1000);
  });

  it.each(["DECLINED", "EXPIRED", "REMOVED", "WITHDRAWN"])(
    "refuses a %s row as NOT_PENDING",
    async (status) => {
      world.rows = [row({ status })];
      await expect(edit({ sharePercent: 20 })).rejects.toMatchObject({
        code: "NOT_PENDING",
      });
      expect(mockTx.collaborator.updateMany).not.toHaveBeenCalled();
    },
  );

  it("answers NOT_FOUND for a row of another plan", async () => {
    world.rows = [row({ webinarPlanId: "plan-2" })];
    await expect(edit({ sharePercent: 20 })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("writes nothing and tells nobody when the terms do not change", async () => {
    world.rows = [row({})];
    await expect(
      edit({ role: "MODERATOR", sharePercent: 10 }),
    ).resolves.toMatchObject({ id: "c-1", revenueShareBps: 1000 });
    expect(mockTx.collaborator.updateMany).not.toHaveBeenCalled();
    expect(mockStageNotices).not.toHaveBeenCalled();
  });

  it("changes a pending row by a status-guarded write, after the plan lock, and tells the invitee", async () => {
    world.rows = [row({})];
    await expect(
      edit({ role: "CO_HOST", sharePercent: 30 }),
    ).resolves.toMatchObject({
      role: "CO_HOST",
      tier: "PRESENTER",
      status: "PENDING",
      revenueShareBps: 3000,
    });
    expect(mockTx.collaborator.updateMany).toHaveBeenCalledWith({
      where: { id: "c-1", status: "PENDING" },
      data: { role: "CO_HOST", tier: "PRESENTER", revenueShareBps: 3000 },
    });
    expect(mockLock.mock.invocationCallOrder[0]).toBe(
      Math.min(...statementOrder()),
    );
    expect(mockStageNotices).toHaveBeenCalledTimes(1);
    expect(mockStageNotices).toHaveBeenCalledWith(
      mockTx,
      "INVITED",
      expect.objectContaining({ id: "c-1", revenueShareBps: 3000 }),
    );
  });

  it("leaves the edited row out of the caps it is checked against", async () => {
    world.rows = [
      row({ role: "CO_HOST", revenueShareBps: 3000 }),
      row({ id: "c-2", revenueShareBps: 4000, status: "ACCEPTED" }),
      row({ id: "c-3", role: "TECHNICAL_SUPPORT", revenueShareBps: 100 }),
    ];
    // Three live rows, the one presenter and 49% left over: all its own.
    await expect(edit({ sharePercent: 49 })).resolves.toMatchObject({
      role: "CO_HOST",
      revenueShareBps: 4900,
    });
    await expect(edit({ sharePercent: 50 })).rejects.toMatchObject({
      code: "SHARES_EXCEEDED",
      detail: { availablePercent: 49 },
    });
  });

  it("refuses a second presenter by edit", async () => {
    world.rows = [row({}), row({ id: "c-2", role: "CO_HOST" })];
    await expect(edit({ role: "CO_HOST" })).rejects.toMatchObject({
      code: "PRESENTER_TAKEN",
    });
  });

  it("answers NOT_PENDING when the invitation is answered between the read and the write", async () => {
    world.rows = [row({})];
    mockTx.collaborator.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(edit({ sharePercent: 20 })).rejects.toMatchObject({
      code: "NOT_PENDING",
    });
    expect(mockStageNotices).not.toHaveBeenCalled();
  });
});
