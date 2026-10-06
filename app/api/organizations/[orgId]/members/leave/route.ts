import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { hasOrgPermission } from "@/lib/auth/org-permissions";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";
import {
  MembershipGuardError,
  assertNotLastOwner,
  assertNotTombstone,
  countRemovalObligations,
} from "@/lib/enterprise/membership-guards";
import { transitionMembership } from "@/lib/enterprise/transitions";
import { releaseSeatsForTerminatedAssignments } from "@/lib/api/organizations/seat-count";
import { recomputeConsultantIsIndependent } from "@/lib/api/organizations/membership-transitions";
import { revokeMemberStreamAccess } from "@/lib/enterprise/member-removal";
import { withSerializableRetry } from "@/lib/db/serializable-retry";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const access = await requireOrgAccess(orgId, { requireActive: true });
  if (access.error) return access.error;

  const memberId = access.member.id;
  const userId = access.session.user.id;

  try {
    await withSerializableRetry(() =>
      prisma.$transaction(
        async (tx) => {
          const current = await tx.membership.findFirst({
            where: { id: memberId, organizationId: orgId },
          });
          if (!current) {
            throw Object.assign(new Error("Member not found"), {
              httpStatus: 404,
            });
          }
          assertNotTombstone(current);

          if (
            hasOrgPermission(current.role, "org.delete") &&
            current.status === "ACTIVE"
          ) {
            await assertNotLastOwner(tx, orgId, memberId);
          }

          const now = new Date();
          const obligations = await countRemovalObligations(tx, current, now);
          const total = Object.values(obligations).reduce(
            (sum, n) => sum + n,
            0,
          );
          if (total > 0) {
            throw new MembershipGuardError(
              "MEMBER_HAS_OBLIGATIONS",
              "You still have upcoming sessions, program seats, or money in progress under this organization. Settle or cancel those before leaving.",
              409,
              { ...obligations },
            );
          }

          await transitionMembership(tx, {
            where: { id: memberId, organizationId: orgId },
            to: "REMOVED",
          });

          if (current.role === "EXPERT" && current.consultantProfileId) {
            await recomputeConsultantIsIndependent(
              tx,
              current.consultantProfileId,
            );
          }

          const terminated = await tx.programAssignment.updateMany({
            where: {
              membershipId: memberId,
              periodEnd: { gte: now },
              status: { in: ["ACTIVE", "PAUSED"] },
            },
            data: { periodEnd: now, status: "CANCELLED" },
          });
          await releaseSeatsForTerminatedAssignments(tx, [memberId], now);

          await tx.orgAuditLog.create({
            data: {
              organizationId: orgId,
              actorMembershipId: memberId,
              targetMembershipId: memberId,
              category: "MEMBER",
              action: AUDIT_ACTIONS.MEMBER.MEMBER_REMOVED,
              description: "Member left the organization",
              details: {
                selfLeave: true,
                role: current.role,
                previousStatus: current.status,
                assignmentsTerminated: terminated.count,
              },
            },
          });
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    );

    try {
      await revokeMemberStreamAccess({ userId, orgId });
    } catch (streamErr) {
      Sentry.captureException(
        streamErr instanceof Error ? streamErr : new Error(String(streamErr)),
        { tags: { subsystem: "stream", op: "org.member-leave" } },
      );
    }

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
