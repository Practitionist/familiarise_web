/**
 * GET /api/organizations/[orgId]/members/[memberId]/obligations
 *
 * #1854 — what would stop this member's removal, read before the operator
 * confirms. It runs `countRemovalObligations`, the same read the removal
 * guard refuses on, and returns counts with short labels only (no session,
 * seat or payment detail). It is gated like DELETE: a MAINTAINER floor, no
 * self target, and an OWNER, MAINTAINER or BILLING_ADMIN target needs an
 * OWNER.
 */

import { NextResponse, type NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
import {
  MembershipGuardError,
  assertActorMayManage,
  countRemovalObligations,
} from "@/lib/enterprise/membership-guards";
import { describeRemovalObligations } from "@/lib/enterprise/removal-obligations";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ orgId: string; memberId: string }> },
) {
  const { orgId, memberId } = await params;
  const access = await requireOrgAccess(orgId, {
    permission: "members.manage",
  });
  if (access.error) return access.error;

  const membership = await prisma.membership.findFirst({
    where: { id: memberId, organizationId: orgId },
    select: {
      id: true,
      organizationId: true,
      userId: true,
      role: true,
      status: true,
      consultantProfileId: true,
    },
  });
  if (!membership) {
    return NextResponse.json({ error: "Member not found" }, { status: 404 });
  }
  if (membership.id === access.member.id) {
    return NextResponse.json(
      { error: "You cannot remove yourself.", code: "SELF_CHANGE" },
      { status: 403 },
    );
  }
  try {
    assertActorMayManage(
      {
        kind: "member",
        membershipId: access.member.id,
        role: access.member.role,
      },
      membership.role,
    );
  } catch (err) {
    if (!(err instanceof MembershipGuardError)) throw err;
    return NextResponse.json(
      { error: err.message, code: err.code },
      { status: err.httpStatus },
    );
  }

  const counts = await countRemovalObligations(prisma, membership, new Date());
  return NextResponse.json({ items: describeRemovalObligations(counts) });
}
