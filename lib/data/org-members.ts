/**
 * Shared read for the organization members list.
 *
 * Single source of truth for the members table the org Members page
 * renders. The org members server page calls this directly in its SSR
 * prefetch so hydration applies without a fetch waterfall, and the payload
 * matches the client useQuery shape.
 *
 * Returns a fully plain/JSON-safe object: the only non-scalar is the
 * membership `createdAt`, mapped to an ISO string here. The selected
 * relations (membership + user) are not money models, so no result
 * extension touches them and no inspect symbol is present — toPlain is
 * unnecessary.
 */

import prisma from "@/lib/prisma";
import {
  MEMBER_EXPERT_SELECT,
  buildOrgMembersQuery,
  toRoleCounts,
} from "@/lib/data/org-members-query";
import type {
  MemberRow,
  MembersListQuery,
  MembersListResult,
} from "@/schemas/organizations";

/**
 * #902 — the prefetch and the client query must produce the SAME cache entry:
 * both key on `membersListKey(orgId, query)` and hold a `MembersListResult`.
 */
export async function getOrgMembers(
  orgId: string,
  query: MembersListQuery,
  opts: { canSeePayout: boolean },
): Promise<MembersListResult> {
  const { where, countsWhere, orderBy, skip, take } = buildOrgMembersQuery(
    orgId,
    query,
  );

  const [total, rows, groups] = await prisma.$transaction([
    prisma.membership.count({ where }),
    prisma.membership.findMany({
      where,
      select: {
        id: true,
        role: true,
        status: true,
        payoutRecipient: true,
        createdAt: true,
        user: { select: { id: true, name: true, email: true, image: true } },
        consultantProfile: { select: MEMBER_EXPERT_SELECT },
      },
      orderBy,
      skip,
      take,
    }),
    prisma.membership.groupBy({
      by: ["role"],
      where: countsWhere,
      _count: { _all: true },
      orderBy: { role: "asc" },
    }),
  ]);

  return {
    total,
    counts: toRoleCounts(groups),
    members: rows.map((r) => ({
      id: r.id,
      role: r.role,
      // The query's status filter never admits ERASED.
      status: r.status as MemberRow["status"],
      // Finance data: `payouts.read` only, as the members route shapes it.
      ...(opts.canSeePayout && { payoutRecipient: r.payoutRecipient }),
      createdAt: r.createdAt.toISOString(),
      user: r.user,
      consultantProfile: r.consultantProfile,
    })),
  };
}
