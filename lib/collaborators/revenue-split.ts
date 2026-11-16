import type { PrismaLike } from "@/lib/prisma";
import { teamAsOf, type PlanRef } from "@/lib/collaborators/team";
import type { RevenueSplit } from "@/types/collaborators";

/**
 * Divides a sale between the plan's owner and the team that was on the plan at
 * `at`: a seat's capture time, or for a replay the start of the recorded
 * session. Each collaborator takes the floor of their basis points and the
 * owner takes the remainder, so no paisa is minted or lost. Returns nothing
 * when the plan had no team, which tells settlement the owner takes the whole
 * sale. A buyer who is also on the team earns no share of their own seat, and
 * a collaborator whose profile is erased takes none at all.
 */
export async function calculateRevenueSplit(
  ref: PlanRef,
  totalAmount: number,
  db: PrismaLike,
  opts: { at: Date; excludeBuyerUserId?: string },
): Promise<RevenueSplit[]> {
  const team = (
    await teamAsOf(db, ref, opts.at, { liveProfilesOnly: true })
  ).filter((member) => member.userId !== opts.excludeBuyerUserId);
  if (team.length === 0) return [];

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
    ref.planType === "webinar"
      ? await db.webinarPlan.findUnique({
          where: { id: ref.planId },
          select: { consultantProfileId: true, organizationId: true },
        })
      : await db.classPlan.findUnique({
          where: { id: ref.planId },
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
