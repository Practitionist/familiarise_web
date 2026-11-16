/** @jest-environment node */

// Who a signed-in user is to a plan's collaborations, and what each kind of
// viewer is shown, through the real resolver and the real plan-team reader.

jest.mock("@/lib/prisma", () => ({ __esModule: true, default: {} }));

import type { PrismaLike } from "@/lib/prisma";
import { getPlanTeamForUser } from "@/lib/collaborators/queries";
import {
  COLLABORATOR_VIEW_SELECT,
  resolveCollaborationViewer,
} from "@/lib/collaborators/viewer";

type Membership = {
  userId: string;
  organizationId: string;
  consultantProfileId: string | null;
  status: string;
  role: string;
};
type TeamRow = {
  id: string;
  role: string;
  tier: string;
  status: string;
  revenueShareBps: number;
  createdAt: Date;
  updatedAt: Date;
  acceptedAt: Date | null;
  consultantProfile: {
    id: string;
    userId: string;
    user: { name: string; image: null };
  };
};

const DAY_MS = 86_400_000;
const SENT_AT = new Date("2027-01-01T00:00:00Z");
const PROFILE_OF: Record<string, string> = {
  "u-owner": "cp-owner",
  "u-presenter": "cp-presenter",
  "u-crew": "cp-crew",
  "u-invitee": "cp-invitee",
  "u-left": "cp-left",
  "u-expert": "cp-expert",
};

const teamRow = (
  who: string,
  status: string,
  role: string,
  revenueShareBps: number,
): TeamRow => ({
  id: `c-${who}`,
  role,
  tier: role === "CO_HOST" ? "PRESENTER" : "CREW",
  status,
  revenueShareBps,
  createdAt: SENT_AT,
  updatedAt: SENT_AT,
  acceptedAt: status === "ACCEPTED" ? SENT_AT : null,
  consultantProfile: {
    id: `cp-${who}`,
    userId: `u-${who}`,
    user: { name: who, image: null },
  },
});

const world = {
  plan: null as {
    consultantProfileId: string | null;
    organizationId: string | null;
    archivedAt: Date | null;
    organization: { status: string } | null;
  } | null,
  memberships: [] as Membership[],
  rows: [] as TeamRow[],
};

type RowWhere = {
  webinarPlanId?: string;
  consultantProfileId?: string;
  status: { in: string[] };
};
const liveRows = ({ where }: { where: RowWhere }) =>
  world.rows.filter(
    (r) =>
      where.status.in.includes(r.status) &&
      (where.consultantProfileId === undefined ||
        r.consultantProfile.id === where.consultantProfileId),
  );

const findPlan = jest.fn(async ({ where }: { where: { id: string } }) =>
  where.id === "plan-1" ? world.plan : null,
);
const mockDb = {
  webinarPlan: { findUnique: findPlan },
  classPlan: { findUnique: findPlan },
  consultantProfile: {
    findFirst: jest.fn(async ({ where }: { where: { userId: string } }) =>
      PROFILE_OF[where.userId] ? { id: PROFILE_OF[where.userId] } : null,
    ),
  },
  membership: {
    count: jest.fn(
      async ({ where }: { where: Partial<Membership> }) =>
        world.memberships.filter((m) =>
          Object.entries(where).every(
            ([key, value]) => m[key as keyof Membership] === value,
          ),
        ).length,
    ),
    findUnique: jest.fn(
      async ({
        where,
      }: {
        where: { userId_organizationId: Partial<Membership> };
      }) =>
        world.memberships.find(
          (m) =>
            m.userId === where.userId_organizationId.userId &&
            m.organizationId === where.userId_organizationId.organizationId,
        ) ?? null,
    ),
  },
  collaborator: {
    findFirst: jest.fn(
      async (query: { where: RowWhere }) => liveRows(query)[0] ?? null,
    ),
    findMany: jest.fn(async (query: { where: RowWhere }) => liveRows(query)),
  },
};
const db = mockDb as unknown as PrismaLike;

const ref = { planType: "webinar", planId: "plan-1" } as const;
const viewerOf = async (userId: string) =>
  (await resolveCollaborationViewer(db, ref, userId)).viewer;

const personalPlan = () => ({
  consultantProfileId: "cp-owner",
  organizationId: null,
  archivedAt: null,
  organization: null,
});
const orgPlan = (status = "ACTIVE", owner: string | null = "cp-owner") => ({
  consultantProfileId: owner,
  organizationId: "org-1",
  archivedAt: null,
  organization: { status },
});
const member = (
  userId: string,
  role: string,
  status = "ACTIVE",
): Membership => ({
  userId,
  organizationId: "org-1",
  consultantProfileId: PROFILE_OF[userId] ?? null,
  status,
  role,
});

beforeEach(() => {
  world.plan = personalPlan();
  world.memberships = [];
  world.rows = [
    teamRow("presenter", "ACCEPTED", "CO_HOST", 3000),
    teamRow("crew", "ACCEPTED", "MODERATOR", 1000),
    teamRow("invitee", "PENDING", "TECHNICAL_SUPPORT", 500),
    teamRow("left", "WITHDRAWN", "GUEST_SPEAKER", 700),
  ];
});

describe("resolveCollaborationViewer", () => {
  it("names the plan's own expert its manager, with the facts a route needs", async () => {
    await expect(
      resolveCollaborationViewer(db, ref, "u-owner"),
    ).resolves.toEqual({
      plan: {
        ownerProfileId: "cp-owner",
        organizationId: null,
        archivedAt: null,
      },
      viewer: { kind: "manager", via: "owner", canWrite: true },
      callerProfileId: "cp-owner",
    });
  });

  it("answers no plan for an id that names none", async () => {
    await expect(
      resolveCollaborationViewer(
        db,
        { planType: "class", planId: "nope" },
        "u-owner",
      ),
    ).resolves.toEqual({
      plan: null,
      viewer: { kind: "none" },
      callerProfileId: "cp-owner",
    });
  });

  it.each([
    [
      "the presenter",
      "u-presenter",
      { kind: "presenter", collaboratorId: "c-presenter" },
    ],
    ["a crew member", "u-crew", { kind: "crew", collaboratorId: "c-crew" }],
    [
      "an invitee",
      "u-invitee",
      { kind: "invitee", collaboratorId: "c-invitee" },
    ],
    ["someone who left the team", "u-left", { kind: "none" }],
    ["another expert", "u-expert", { kind: "none" }],
    ["a user with no expert profile", "u-learner", { kind: "none" }],
  ])("resolves %s", async (_name, userId, viewer) => {
    await expect(viewerOf(userId)).resolves.toEqual(viewer);
  });

  describe("on an organisation's plan", () => {
    it.each<[string, Membership[], string, object]>([
      [
        "the owning expert, an active expert member",
        [member("u-owner", "EXPERT")],
        "u-owner",
        { kind: "manager", via: "owner", canWrite: true },
      ],
      [
        "the owning expert whose membership was removed",
        [member("u-owner", "EXPERT", "REMOVED")],
        "u-owner",
        { kind: "none" },
      ],
      [
        "the owning expert who is now only a learner there",
        [member("u-owner", "LEARNER")],
        "u-owner",
        { kind: "none" },
      ],
      [
        "an operator who manages the catalogue",
        [member("u-ops", "MANAGER")],
        "u-ops",
        { kind: "manager", via: "org", canWrite: true },
      ],
      [
        "an operator without catalogue rights",
        [member("u-ops", "BILLING_ADMIN")],
        "u-ops",
        { kind: "none" },
      ],
      [
        "a catalogue manager whose membership is suspended",
        [member("u-ops", "MANAGER", "SUSPENDED")],
        "u-ops",
        { kind: "none" },
      ],
      [
        "an expert member who does not own the plan",
        [member("u-expert", "EXPERT")],
        "u-expert",
        { kind: "none" },
      ],
    ])("resolves %s", async (_name, memberships, userId, viewer) => {
      world.plan = orgPlan();
      world.memberships = memberships;
      await expect(viewerOf(userId)).resolves.toEqual(viewer);
    });

    it("lets an operator manage a plan that has no owning expert", async () => {
      world.plan = orgPlan("ACTIVE", null);
      world.memberships = [member("u-ops", "OWNER")];
      await expect(
        resolveCollaborationViewer(db, ref, "u-ops"),
      ).resolves.toMatchObject({
        viewer: { kind: "manager", via: "org", canWrite: true },
        callerProfileId: null,
      });
      // A caller with no profile is never matched to a plan with no owner.
      world.memberships = [];
      await expect(viewerOf("u-learner")).resolves.toEqual({ kind: "none" });
    });

    it.each(["SUSPENDED", "PENDING_VERIFICATION"])(
      "keeps both kinds of manager read-only while the organisation is %s",
      async (status) => {
        world.plan = orgPlan(status);
        world.memberships = [
          member("u-owner", "EXPERT"),
          member("u-ops", "OWNER"),
        ];
        await expect(viewerOf("u-owner")).resolves.toEqual({
          kind: "manager",
          via: "owner",
          canWrite: false,
        });
        await expect(viewerOf("u-ops")).resolves.toEqual({
          kind: "manager",
          via: "org",
          canWrite: false,
        });
      },
    );

    it("gives a deactivated organisation no manager at all", async () => {
      world.plan = orgPlan("DEACTIVATED");
      world.memberships = [
        member("u-owner", "EXPERT"),
        member("u-ops", "OWNER"),
      ];
      await expect(viewerOf("u-owner")).resolves.toEqual({ kind: "none" });
      await expect(viewerOf("u-ops")).resolves.toEqual({ kind: "none" });
    });
  });
});

describe("what each viewer is shown of the team", () => {
  const teamFor = async (userId: string) => {
    const result = await getPlanTeamForUser(ref, userId, db);
    return result.status === "ok" ? result.data : result.status;
  };
  const shares = async (userId: string) => {
    const team = await teamFor(userId);
    return typeof team === "string"
      ? team
      : team.map((c) => [c.id, c.revenueShareBps]);
  };

  it("shows a manager every live row with its share and when a pending one lapses", async () => {
    const team = await teamFor("u-owner");
    expect(team).toEqual([
      expect.objectContaining({
        id: "c-presenter",
        revenueShareBps: 3000,
        expiresAt: null,
      }),
      expect.objectContaining({
        id: "c-crew",
        revenueShareBps: 1000,
        expiresAt: null,
      }),
      expect.objectContaining({
        id: "c-invitee",
        revenueShareBps: 500,
        expiresAt: new Date(SENT_AT.getTime() + 14 * DAY_MS),
      }),
    ]);
    expect(mockDb.collaborator.findMany).toHaveBeenCalledWith({
      where: {
        webinarPlanId: "plan-1",
        status: { in: ["PENDING", "ACCEPTED"] },
        consultantProfile: { deletedAt: null },
      },
      select: COLLABORATOR_VIEW_SELECT,
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
  });

  it.each([
    [
      "the presenter",
      "u-presenter",
      [
        ["c-presenter", 3000],
        ["c-crew", null],
      ],
    ],
    [
      "a crew member",
      "u-crew",
      [
        ["c-presenter", null],
        ["c-crew", 1000],
      ],
    ],
    [
      "an invitee, who sees their own row and the accepted team only",
      "u-invitee",
      [
        ["c-presenter", null],
        ["c-crew", null],
        ["c-invitee", 500],
      ],
    ],
  ])(
    "shows %s their own share and withholds a peer's as null, never zero",
    async (_name, userId, expected) => {
      await expect(shares(userId)).resolves.toEqual(expected);
    },
  );

  it("hides another invitee's pending row from an invitee", async () => {
    world.rows.push(teamRow("expert", "PENDING", "GUEST_SPEAKER", 900));
    await expect(shares("u-invitee")).resolves.toEqual([
      ["c-presenter", null],
      ["c-crew", null],
      ["c-invitee", 500],
    ]);
    await expect(shares("u-presenter")).resolves.toEqual([
      ["c-presenter", 3000],
      ["c-crew", null],
    ]);
  });

  it.each([
    ["forbidden", "someone who is not on the team", "u-expert", "plan-1"],
    ["not_found", "a plan that does not exist", "u-owner", "nope"],
  ])(
    "answers %s to %s without reading the team",
    async (status, _name, userId, planId) => {
      await expect(
        getPlanTeamForUser({ planType: "webinar", planId }, userId, db),
      ).resolves.toEqual({ status });
      expect(mockDb.collaborator.findMany).not.toHaveBeenCalled();
    },
  );

  it("builds every view from columns that carry no response time and no contact detail", async () => {
    const team = await teamFor("u-owner");
    expect(Object.keys(COLLABORATOR_VIEW_SELECT)).not.toContain("respondedAt");
    expect(COLLABORATOR_VIEW_SELECT.consultantProfile).toEqual({
      select: {
        id: true,
        userId: true,
        user: { select: { name: true, image: true } },
      },
    });
    expect(JSON.stringify(team)).not.toMatch(/respondedAt|updatedAt/);
  });
});
