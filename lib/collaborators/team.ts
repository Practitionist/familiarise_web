import type {
  CollaboratorRole,
  CollaboratorTier,
  Prisma,
} from "@prisma/client";
import type { PrismaLike, Tx } from "@/lib/prisma";

export type PlanType = "webinar" | "class";

/** A webinar or class plan, the only plans that carry collaborators. */
export type PlanRef = { planType: PlanType; planId: string };

/** One collaborator on a plan's team, as money and access code read them. */
export type TeamMember = {
  collaboratorId: string;
  consultantProfileId: string;
  userId: string;
  role: CollaboratorRole;
  tier: CollaboratorTier;
  revenueShareBps: number;
};

const TEAM_MEMBER_SELECT = {
  id: true,
  consultantProfileId: true,
  role: true,
  tier: true,
  revenueShareBps: true,
  consultantProfile: { select: { userId: true } },
} satisfies Prisma.CollaboratorSelect;

type TeamMemberRow = Prisma.CollaboratorGetPayload<{
  select: typeof TEAM_MEMBER_SELECT;
}>;

const toTeamMember = (row: TeamMemberRow): TeamMember => ({
  collaboratorId: row.id,
  consultantProfileId: row.consultantProfileId,
  userId: row.consultantProfile.userId,
  role: row.role,
  tier: row.tier,
  revenueShareBps: row.revenueShareBps,
});

export function planWhere(ref: PlanRef): Prisma.CollaboratorWhereInput {
  return ref.planType === "webinar"
    ? { webinarPlanId: ref.planId }
    : { classPlanId: ref.planId };
}

/**
 * Locks the plan row for the rest of the transaction, so team changes and
 * schedule changes on one plan queue instead of reading each other's stale
 * state. NO KEY UPDATE does not block inserts of rows that reference the plan.
 */
export async function lockPlanRow(tx: Tx, ref: PlanRef): Promise<void> {
  if (ref.planType === "webinar") {
    await tx.$queryRaw`SELECT 1 FROM "WebinarPlan" WHERE "id" = ${ref.planId} FOR NO KEY UPDATE`;
  } else {
    await tx.$queryRaw`SELECT 1 FROM "ClassPlan" WHERE "id" = ${ref.planId} FOR NO KEY UPDATE`;
  }
}

/** Who is on the plan's team right now. An erased profile is never on it. */
export async function currentTeam(
  db: PrismaLike,
  ref: PlanRef,
): Promise<TeamMember[]> {
  const rows = await db.collaborator.findMany({
    where: {
      ...planWhere(ref),
      status: "ACCEPTED",
      consultantProfile: { deletedAt: null },
    },
    select: TEAM_MEMBER_SELECT,
    orderBy: [{ acceptedAt: "asc" }, { id: "asc" }],
  });
  return rows.map(toTeamMember);
}

/**
 * Who was on the plan's team at `at`: accepted at or before it and not ended
 * by it. Reads the rows' own period, so the answer is the same whenever it is
 * asked, which is what a payment split retried later depends on.
 * `liveProfilesOnly` leaves out a member whose profile is erased today.
 */
export async function teamAsOf(
  db: PrismaLike,
  ref: PlanRef,
  at: Date,
  opts: { liveProfilesOnly?: boolean } = {},
): Promise<TeamMember[]> {
  const rows = await db.collaborator.findMany({
    where: {
      ...planWhere(ref),
      acceptedAt: { lte: at },
      OR: [{ endedAt: null }, { endedAt: { gt: at } }],
      ...(opts.liveProfilesOnly
        ? { consultantProfile: { deletedAt: null } }
        : {}),
    },
    select: TEAM_MEMBER_SELECT,
    orderBy: [{ acceptedAt: "asc" }, { id: "asc" }],
  });
  return rows.map(toTeamMember);
}
