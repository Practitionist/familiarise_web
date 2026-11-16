import type { PrismaLike } from "@/lib/prisma";
import { currentTeam, type PlanType } from "@/lib/collaborators/team";
import type { RevenueSplit } from "@/types/collaborators";

/** The most a plan's collaborators may hold together: its owner keeps a tenth. */
const MAX_TEAM_SHARE_BPS = 9000;

/**
 * Divides a seat's price between the plan's owner and its team. Each
 * collaborator takes the floor of their basis points and the owner takes the
 * remainder, so no paisa is minted or lost. Returns nothing when the plan has
 * no team, which tells settlement the owner takes the whole seat. A buyer who
 * is also on the team earns no share of their own seat.
 */
export async function calculateRevenueSplit(
  planType: PlanType,
  planId: string,
  totalAmount: number,
  db: PrismaLike,
  opts: { excludeBuyerUserId?: string } = {},
): Promise<RevenueSplit[]> {
  const team = (await currentTeam(db, { planType, planId })).filter(
    (member) => member.userId !== opts.excludeBuyerUserId,
  );
  if (team.length === 0) return [];

  const teamBps = team.reduce((sum, m) => sum + m.revenueShareBps, 0);
  if (teamBps > MAX_TEAM_SHARE_BPS) {
    throw new Error(
      `calculateRevenueSplit: collaborator shares sum to ${teamBps} bps (> ${MAX_TEAM_SHARE_BPS}) on ${planType} plan ${planId}`,
    );
  }

  const splits: RevenueSplit[] = [];
  let teamTotal = 0;
  for (const member of team) {
    const share = Math.floor((totalAmount * member.revenueShareBps) / 10_000);
    teamTotal += share;
    splits.push({
      consultantProfileId: member.consultantProfileId,
      share,
      role: member.role,
    });
  }

  const plan =
    planType === "webinar"
      ? await db.webinarPlan.findUnique({
          where: { id: planId },
          select: { consultantProfileId: true, organizationId: true },
        })
      : await db.classPlan.findUnique({
          where: { id: planId },
          select: { consultantProfileId: true, organizationId: true },
        });
  const ownerConsultantProfileId = plan?.consultantProfileId ?? null;
  const ownerOrganizationId = plan?.organizationId ?? null;

  if (ownerConsultantProfileId || ownerOrganizationId) {
    splits.unshift({
      consultantProfileId: ownerConsultantProfileId,
      organizationId: ownerOrganizationId,
      share: totalAmount - teamTotal,
      role: "OWNER",
    });
  }

  return splits;
}
