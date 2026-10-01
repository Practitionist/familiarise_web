/**
 * GET    /api/organizations/[orgId]/members
 * POST   /api/organizations/[orgId]/members (405: members join by invitation)
 *
 * The single members endpoint subsumes the old /consultants and /learners
 * views. GET takes `role` and `status` (comma lists), `q`, `departmentLabel`,
 * `sort` (name|role|joined) + `dir` and pagination, all bounded by
 * `MembersListQuerySchema`, and returns `counts` by role for the filter chips
 * (#1527). ERASED rows are never listed.
 *
 * Everything is parsed through Zod. Runtime narrowing never relies on
 * `as` assertions.
 */

import { NextResponse, type NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import {
  MEMBER_EXPERT_SELECT,
  buildOrgMembersQuery,
  toRoleCounts,
} from "@/lib/data/org-members-query";
import { hasOrgPermission } from "@/lib/auth/org-permissions";
import { MembersListQuerySchema } from "@/schemas/organizations";
import { requireOrgAccess } from "@/lib/auth-helpers";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  // members.read (OWNER/MAINTAINER/MANAGER/SUPPORT) — the roster is an
  // operator surface. The old `|| finance` branch admitted BILLING_ADMIN,
  // contradicting its operator-blind role design; the consent member-picker
  // it served is itself consent.read-gated (no BILLING_ADMIN) now.
  const access = await requireOrgAccess(orgId, { permission: "members.read" });
  if (access.error) return access.error;

  const parsed = MembersListQuerySchema.safeParse(
    Object.fromEntries(new URL(req.url).searchParams.entries()),
  );
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid query", detail: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const { page, perPage } = parsed.data;
  const { where, countsWhere, orderBy, skip, take } = buildOrgMembersQuery(
    orgId,
    parsed.data,
  );

  const [total, data, groups] = await prisma.$transaction([
    prisma.membership.count({ where }),
    prisma.membership.findMany({
      where,
      include: {
        user: {
          select: { id: true, name: true, email: true, image: true },
        },
        // ConsultantProfile + ConsulteeProfile are 1:1 optionals. Always
        // including them here means the consultants page gets
        // `headline / rating / isVerified` in one round-trip without
        // needing a separate /consultants endpoint.
        consultantProfile: { select: MEMBER_EXPERT_SELECT },
        consulteeProfile: {
          select: { id: true },
        },
      },
      orderBy,
      skip,
      take,
    }),
    // #1527 — one groupBy feeds every role chip.
    prisma.membership.groupBy({
      by: ["role"],
      where: countsWhere,
      _count: { _all: true },
      orderBy: { role: "asc" },
    }),
  ]);

  // #1527 — payout routing is finance data: `payouts.read` holders only.
  // members.manage ⊂ payouts.read, so every editor still receives it.
  const canSeePayout = hasOrgPermission(access.member.role, "payouts.read");
  return NextResponse.json({
    data: canSeePayout
      ? data
      : data.map((m) => ({ ...m, payoutRecipient: undefined })),
    meta: { total, page, perPage },
    counts: toRoleCounts(groups),
  });
}

/**
 * #1846 bucket C — direct-add is retired. Joining is invite + accept only:
 * "Add people" and bulk import send an Invitation, which the person accepts
 * with the DPDP consent step. This route used to create an ACTIVE membership
 * (or reactivate a REMOVED one) that the person never agreed to. SSO JIT
 * provisions on its own path and never called it.
 */
export function POST() {
  return NextResponse.json(
    {
      error:
        "Members join by accepting an invitation. Send one with POST /api/organizations/<orgId>/invitations.",
      code: "USE_INVITATIONS",
    },
    { status: 405, headers: { Allow: "GET" } },
  );
}
