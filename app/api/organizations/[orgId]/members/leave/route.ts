import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { MembershipGuardError } from "@/lib/enterprise/membership-guards";
import { removeMember } from "@/lib/enterprise/member-removal";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const access = await requireOrgAccess(orgId, { allowSuspended: true });
  if (access.error) return access.error;

  const userId = access.session.user.id;
  const realMember = await prisma.membership.findUnique({
    where: {
      userId_organizationId: {
        userId,
        organizationId: orgId,
      },
    },
    select: { id: true, role: true, status: true },
  });
  if (
    !realMember ||
    realMember.status === "REMOVED" ||
    realMember.status === "ERASED"
  ) {
    return NextResponse.json(
      { error: "Not a member of this organization" },
      { status: 403 },
    );
  }

  try {
    await removeMember({
      orgId,
      memberId: realMember.id,
      actor: {
        kind: "self",
        membershipId: realMember.id,
        role: realMember.role,
      },
      actorUserId: userId,
      force: false,
      releaseActiveSeats: true,
    });

    return NextResponse.json({ left: true });
  } catch (err) {
    if (err instanceof MembershipGuardError) {
      return NextResponse.json(
        {
          error: err.message,
          code: err.code,
          ...(err.counts && { counts: err.counts }),
        },
        { status: err.httpStatus },
      );
    }
    if (err instanceof Error && "httpStatus" in err) {
      const status = typeof err.httpStatus === "number" ? err.httpStatus : 500;
      return NextResponse.json({ error: err.message }, { status });
    }
    Sentry.captureException(
      err instanceof Error ? err : new Error(String(err)),
      { tags: { subsystem: "organizations" } },
    );
    return NextResponse.json(
      { error: "Failed to leave organization" },
      { status: 500 },
    );
  }
}
