/**
 * #1527 — the members roster's filter, sort and page window, shared by
 * GET /api/organizations/[orgId]/members and the Members page's SSR prefetch.
 * Pure (no prisma client) so it is testable on its own.
 */

import type { MemberRole, Prisma } from "@prisma/client";
import {
  MEMBER_LIST_STATUSES,
  type MembersListQuery,
} from "@/schemas/organizations";

const BY_NAME = (dir: Prisma.SortOrder) => ({ user: { name: dir } });

// A unique tiebreaker keeps pages stable when names or dates repeat.
const ORDER: Record<
  MembersListQuery["sort"],
  (dir: Prisma.SortOrder) => Prisma.MembershipOrderByWithRelationInput[]
> = {
  name: (dir) => [BY_NAME(dir), { id: "asc" }],
  role: (dir) => [{ role: dir }, BY_NAME("asc"), { id: "asc" }],
  joined: (dir) => [{ createdAt: dir }, { id: "asc" }],
};

export function buildOrgMembersQuery(orgId: string, query: MembersListQuery) {
  // ERASED is server-enforced out: an absent status means every listed one.
  const scope: Prisma.MembershipWhereInput = {
    organizationId: orgId,
    status: { in: query.status ?? [...MEMBER_LIST_STATUSES] },
    ...(query.departmentLabel && { departmentLabel: query.departmentLabel }),
  };
  const where: Prisma.MembershipWhereInput = {
    ...scope,
    ...(query.role && { role: { in: query.role } }),
    ...(query.q && {
      user: {
        OR: [
          { name: { contains: query.q, mode: "insensitive" } },
          { email: { contains: query.q, mode: "insensitive" } },
        ],
      },
    }),
  };
  return {
    where,
    // The role chips count under the status filter only, so picking a role
    // or typing a search never hides the other chips.
    countsWhere: scope,
    orderBy: ORDER[query.sort](query.dir),
    skip: (query.page - 1) * query.perPage,
    take: query.perPage,
  };
}

/**
 * #1527 — what an EXPERT row shows under the name (headline, 1:1 score and its
 * count, verified). Selected on the page's findMany, so one batched read.
 */
export const MEMBER_EXPERT_SELECT = {
  id: true,
  headline: true,
  // The published two-track scores, never the raw mean (#1300).
  publishedRatingOneToOne: true,
  publishedRatingGroup: true,
  ratedClientsOneToOne: true,
  isVerified: true,
} satisfies Prisma.ConsultantProfileSelect;

export function toRoleCounts(
  groups: { role: MemberRole; _count: { _all: number } }[],
): Partial<Record<MemberRole, number>> {
  return Object.fromEntries(groups.map((g) => [g.role, g._count._all]));
}
