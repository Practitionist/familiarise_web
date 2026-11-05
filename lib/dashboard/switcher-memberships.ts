import prisma from "@/lib/prisma";

/**
 * The memberships the dashboard switcher lists. `all` widens the session's
 * ACTIVE-only view to PENDING and SUSPENDED memberships and any org that is not
 * deactivated, because the session deliberately omits them.
 */
export function findSwitcherMemberships(userId: string, all: boolean) {
  return prisma.membership.findMany({
    where: all
      ? {
          userId,
          status: { in: ["ACTIVE", "PENDING", "SUSPENDED"] },
          organization: { status: { not: "DEACTIVATED" } },
        }
      : { userId, status: "ACTIVE" },
    orderBy: { createdAt: "asc" },
    select: {
      organizationId: true,
      role: true,
      status: true,
      organization: {
        select: {
          name: true,
          status: true,
          brandingProfile: { select: { logo: true } },
        },
      },
    },
  });
}
