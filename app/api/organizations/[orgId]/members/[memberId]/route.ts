/**
 * Single org member — PATCH (role/status) / DELETE (soft remove).
 *
 * Auth: ORG_ADMIN+ on both. The last ORG_OWNER cannot be demoted or removed.
 * Role/status changes to ORG_CONSULTANT / ORG_SUPPORT are gated behind
 * ENABLE_PROVIDER_ORGS.
 *
 * `memberId` in the URL refers to the OrganizationMemberProfile.id (our typed
 * sibling), NOT the BetterAuth Member.id — the sibling is what UI code touches.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { ENABLE_PROVIDER_ORGS } from "@/lib/feature-flags";
import { acquireSeat, releaseSeat } from "@/lib/api/organizations/seat-helpers";
import { OrgAuditAction, OrgMemberRole, OrgMemberStatus, Prisma } from "@prisma/client";

const patchMemberSchema = z.object({
  role: z.nativeEnum(OrgMemberRole).optional(),
  status: z.nativeEnum(OrgMemberStatus).optional(),
});

const PROVIDER_GATED_ROLES: OrgMemberRole[] = ["ORG_CONSULTANT", "ORG_SUPPORT"];

async function countActiveOwners(organizationProfileId: string): Promise<number> {
  return prisma.organizationMemberProfile.count({
    where: {
      organizationProfileId,
      role: "ORG_OWNER",
      status: "ACTIVE",
    },
  });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string; memberId: string }> },
) {
  try {
    const { orgId, memberId } = await params;
    const access = await requireOrgAccess(orgId, "ORG_ADMIN");
    if (access.error) return access.error;

    const body = await req.json();
    const parsed = patchMemberSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request body", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const { role, status } = parsed.data;

    if (!ENABLE_PROVIDER_ORGS && role && PROVIDER_GATED_ROLES.includes(role)) {
      return NextResponse.json(
        {
          error: `${role} role is gated behind PROVIDER orgs.`,
          flag: "ENABLE_PROVIDER_ORGS",
        },
        { status: 501 },
      );
    }

    const target = await prisma.organizationMemberProfile.findFirst({
      where: { id: memberId, organizationProfileId: access.org.id },
    });
    if (!target) {
      return NextResponse.json({ error: "Member not found" }, { status: 404 });
    }

    // Last-owner guard — applies to both role demotion and status removal.
    if (target.role === "ORG_OWNER" && target.status === "ACTIVE") {
      const demoting = role !== undefined && role !== "ORG_OWNER";
      const deactivating = status !== undefined && status !== "ACTIVE";
      if (demoting || deactivating) {
        const owners = await countActiveOwners(access.org.id);
        if (owners <= 1) {
          return NextResponse.json(
            { error: "Cannot demote or remove the last organization owner." },
            { status: 400 },
          );
        }
      }
    }

    // Compute seat transition for seatsUsed bookkeeping.
    const oldRole = target.role;
    const oldStatus = target.status;
    const newRole = role ?? oldRole;
    const newStatus = status ?? oldStatus;
    const wasSeatOccupying =
      oldRole === "ORG_LEARNER" && oldStatus === "ACTIVE";
    const isSeatOccupying =
      newRole === "ORG_LEARNER" && newStatus === "ACTIVE";

    // Resolve profile FKs — look up user to link correct profiles.
    let consulteeProfileId: string | null = target.consulteeProfileId;
    let consultantProfileId: string | null = target.consultantProfileId;
    if (role !== undefined && role !== oldRole) {
      const user = await prisma.member.findUnique({
        where: { id: target.memberId },
        select: {
          user: {
            select: { consulteeProfileId: true, consultantProfileId: true },
          },
        },
      });
      consulteeProfileId =
        newRole === "ORG_LEARNER"
          ? user?.user.consulteeProfileId ?? null
          : null;
      consultantProfileId =
        newRole === "ORG_CONSULTANT"
          ? user?.user.consultantProfileId ?? null
          : null;

      // Reject the role change if the target user lacks the required profile.
      if (newRole === "ORG_LEARNER" && !consulteeProfileId) {
        return NextResponse.json(
          { error: "This user has not completed learner onboarding and cannot be assigned ORG_LEARNER." },
          { status: 422 },
        );
      }
      if (newRole === "ORG_CONSULTANT" && !consultantProfileId) {
        return NextResponse.json(
          { error: "This user has not completed consultant onboarding and cannot be assigned ORG_CONSULTANT." },
          { status: 422 },
        );
      }
    }

    const [updated] = await prisma.$transaction(async (tx) => {
      // Atomic seat acquisition/release via conditional UPDATE.
      if (!wasSeatOccupying && isSeatOccupying) {
        const acquired = await acquireSeat(tx, access.org.id);
        if (!acquired) throw new Error("SEAT_LIMIT_REACHED");
      } else if (wasSeatOccupying && !isSeatOccupying) {
        await releaseSeat(tx, access.org.id);
      }

      const profileUpdate = await tx.organizationMemberProfile.update({
        where: { id: memberId },
        data: {
          ...(role !== undefined && { role }),
          ...(status !== undefined && { status }),
          consulteeProfileId,
          consultantProfileId,
          seatAssignedAt: isSeatOccupying && !wasSeatOccupying
            ? new Date()
            : !isSeatOccupying && wasSeatOccupying
              ? null
              : undefined,
        },
      });
      if (role !== undefined) {
        await tx.member.update({
          where: { id: target.memberId },
          data: { role },
        });
      }

      // Audit log — record every role/status change for compliance.
      const isRoleChange = role !== undefined && role !== oldRole;
      const isStatusChange = status !== undefined && status !== oldStatus;
      if (isRoleChange || isStatusChange) {
        const auditDetails: Record<string, unknown> = {};
        let description: string;
        let action: OrgAuditAction;

        if (isRoleChange) {
          auditDetails.roleFrom = oldRole;
          auditDetails.roleTo = role;
          description = `Role changed from ${oldRole} to ${role}`;
          action = OrgAuditAction.ROLE_CHANGE;
        } else {
          auditDetails.statusFrom = oldStatus;
          auditDetails.statusTo = status;
          description = `Status changed from ${oldStatus} to ${status}`;
          action = OrgAuditAction.STATUS_CHANGE;
        }

        await tx.orgAuditLog.create({
          data: {
            organizationProfileId: access.org.id,
            actorMemberId: access.member.id,
            targetMemberId: memberId,
            action,
            description,
            details: auditDetails as Prisma.InputJsonValue,
          },
        });
      }

      // seatsUsed already updated atomically by acquireSeat/releaseSeat above.
      return [profileUpdate];
    });

    return NextResponse.json({ memberProfile: updated });
  } catch (error) {
    if (error instanceof Error && error.message === "SEAT_LIMIT_REACHED") {
      return NextResponse.json(
        { error: "Organization has reached its seat limit." },
        { status: 403 },
      );
    }
    console.error(
      "[API /organizations/[orgId]/members/[memberId] PATCH] error:",
      error,
    );
    return NextResponse.json(
      { error: "Failed to update member" },
      { status: 500 },
    );
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ orgId: string; memberId: string }> },
) {
  try {
    const { orgId, memberId } = await params;
    const access = await requireOrgAccess(orgId, "ORG_ADMIN");
    if (access.error) return access.error;

    const target = await prisma.organizationMemberProfile.findFirst({
      where: { id: memberId, organizationProfileId: access.org.id },
    });
    if (!target) {
      return NextResponse.json({ error: "Member not found" }, { status: 404 });
    }

    if (target.role === "ORG_OWNER" && target.status === "ACTIVE") {
      const owners = await countActiveOwners(access.org.id);
      if (owners <= 1) {
        return NextResponse.json(
          { error: "Cannot remove the last organization owner." },
          { status: 400 },
        );
      }
    }

    const wasSeatOccupying =
      target.role === "ORG_LEARNER" && target.status === "ACTIVE";

    await prisma.$transaction(async (tx) => {
      await tx.organizationMemberProfile.update({
        where: { id: memberId },
        data: { status: "REMOVED" },
      });
      if (wasSeatOccupying) {
        await releaseSeat(tx, access.org.id);
      }
      await tx.orgAuditLog.create({
        data: {
          organizationProfileId: access.org.id,
          actorMemberId: access.member.id,
          targetMemberId: memberId,
          action: OrgAuditAction.MEMBER_REMOVED,
          description: `Member removed (was ${target.role})`,
          details: { role: target.role, previousStatus: target.status },
        },
      });
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error(
      "[API /organizations/[orgId]/members/[memberId] DELETE] error:",
      error,
    );
    return NextResponse.json(
      { error: "Failed to remove member" },
      { status: 500 },
    );
  }
}
