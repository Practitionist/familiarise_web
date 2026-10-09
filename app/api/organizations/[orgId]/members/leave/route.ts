import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { MembershipGuardError } from "@/lib/enterprise/membership-guards";
import { removeMember } from "@/lib/enterprise/member-removal";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const acceptsHtml = req.headers.get("accept")?.includes("text/html") ?? false;
  const respondError = (
    message: string,
    status: number,
    extra?: { code?: string; counts?: Record<string, number> },
  ) => {
    if (acceptsHtml) {
      const target = new URL(
        `/dashboard/organization/${orgId}/my-program`,
        req.url,
      );
      target.searchParams.set("leaveError", extra?.code ?? "LEAVE_FAILED");
      return NextResponse.redirect(target, { status: 303 });
    }
    return NextResponse.json({ error: message, ...extra }, { status });
  };

  const access = await requireOrgAccess(orgId, { allowSuspended: true });
  if (access.error) {
    if (acceptsHtml) {
      return respondError(
        "Unable to access organization",
        access.error.status,
        {
          code: "ACCESS_DENIED",
        },
      );
    }
    return access.error;
  }

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
    return respondError("Not a member of this organization", 403, {
      code: "NOT_A_MEMBER",
    });
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

    if (acceptsHtml) {
      return NextResponse.redirect(new URL("/dashboard", req.url), {
        status: 303,
      });
    }
    return NextResponse.json({ left: true });
  } catch (err) {
    if (err instanceof MembershipGuardError) {
      return respondError(err.message, err.httpStatus, {
        code: err.code,
        ...(err.counts && { counts: err.counts }),
      });
    }
    if (err instanceof Error && "httpStatus" in err) {
      const status = typeof err.httpStatus === "number" ? err.httpStatus : 500;
      return respondError(err.message, status, { code: "LEAVE_FAILED" });
    }
    Sentry.captureException(
      err instanceof Error ? err : new Error(String(err)),
      { tags: { subsystem: "organizations" } },
    );
    return respondError("Failed to leave organization", 500, {
      code: "LEAVE_FAILED",
    });
  }
}
