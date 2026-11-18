// One plan, its organisation's members and its team, held in memory behind the
// Prisma calls the collaboration viewer and the plan-team reader make.

export type WorldMembership = {
  userId: string;
  organizationId: string;
  consultantProfileId: string | null;
  status: string;
  role: string;
};

/** A collaborator in the shape the view select returns. */
export type WorldTeamRow = {
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

type WorldPlan = {
  consultantProfileId: string | null;
  organizationId: string | null;
  archivedAt: Date | null;
  organization: { status: string } | null;
};

type RowWhere = {
  id?: string;
  consultantProfileId?: string;
  status: { in?: string[]; notIn?: string[] };
};

export const SENT_AT = new Date("2027-01-01T00:00:00Z");

/** The users that have an expert profile; any other user id has none. */
export const PROFILE_OF: Record<string, string> = {
  "u-owner": "cp-owner",
  "u-presenter": "cp-presenter",
  "u-crew": "cp-crew",
  "u-invitee": "cp-invitee",
  "u-left": "cp-left",
  "u-expert": "cp-expert",
};

export const teamRow = (
  who: string,
  status: string,
  role: string,
  revenueShareBps: number,
): WorldTeamRow => ({
  id: `c-${who}`,
  role,
  tier: role === "CO_HOST" || role === "CO_INSTRUCTOR" ? "PRESENTER" : "CREW",
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

export const personalPlan = (): WorldPlan => ({
  consultantProfileId: "cp-owner",
  organizationId: null,
  archivedAt: null,
  organization: null,
});

export const orgPlan = (
  status = "ACTIVE",
  owner: string | null = "cp-owner",
): WorldPlan => ({
  consultantProfileId: owner,
  organizationId: "org-1",
  archivedAt: null,
  organization: { status },
});

export const member = (
  userId: string,
  role: string,
  status = "ACTIVE",
): WorldMembership => ({
  userId,
  organizationId: "org-1",
  consultantProfileId: PROFILE_OF[userId] ?? null,
  status,
  role,
});

/**
 * Plan `plan-1`, owned by `u-owner`, with a presenter, a crew member, an
 * invitee and someone who left. `reset` restores exactly that.
 */
export function collaborationWorld() {
  const world = {
    plan: null as WorldPlan | null,
    memberships: [] as WorldMembership[],
    rows: [] as WorldTeamRow[],
  };
  const reset = () => {
    world.plan = personalPlan();
    world.memberships = [];
    world.rows = [
      teamRow("presenter", "ACCEPTED", "CO_HOST", 3000),
      teamRow("crew", "ACCEPTED", "MODERATOR", 1000),
      teamRow("invitee", "PENDING", "TECHNICAL_SUPPORT", 500),
      teamRow("left", "WITHDRAWN", "GUEST_SPEAKER", 700),
    ];
  };
  reset();

  const rowsWhere = ({ where }: { where: RowWhere }) =>
    world.rows.filter(
      (r) =>
        (where.status.in === undefined || where.status.in.includes(r.status)) &&
        !where.status.notIn?.includes(r.status) &&
        (where.id === undefined || r.id === where.id) &&
        (where.consultantProfileId === undefined ||
          r.consultantProfile.id === where.consultantProfileId),
    );
  const findPlan = jest.fn(async ({ where }: { where: { id: string } }) =>
    where.id === "plan-1" ? world.plan : null,
  );
  const db = {
    webinarPlan: { findUnique: findPlan },
    classPlan: { findUnique: findPlan },
    consultantProfile: {
      findFirst: jest.fn(async ({ where }: { where: { userId: string } }) =>
        PROFILE_OF[where.userId] ? { id: PROFILE_OF[where.userId] } : null,
      ),
    },
    membership: {
      count: jest.fn(
        async ({ where }: { where: Partial<WorldMembership> }) =>
          world.memberships.filter((m) =>
            Object.entries(where).every(
              ([key, value]) => m[key as keyof WorldMembership] === value,
            ),
          ).length,
      ),
      findUnique: jest.fn(
        async ({
          where,
        }: {
          where: { userId_organizationId: Partial<WorldMembership> };
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
        async (query: { where: RowWhere }) => rowsWhere(query)[0] ?? null,
      ),
      findMany: jest.fn(async (query: { where: RowWhere }) => rowsWhere(query)),
    },
  };
  return { world, db, reset };
}
