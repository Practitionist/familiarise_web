/**
 * GET    /api/organizations/[orgId]/invitations/[invitationId]
 * DELETE /api/organizations/[orgId]/invitations/[invitationId]
 *
 * DELETE soft-cancels a pending invitation so the accept endpoint will
 * reject the token. We keep the row with status=canceled instead of
 * hard-deleting so audit trails stay intact and the inviter can see
 * that it was revoked rather than it silently disappearing from the
 * list.
 */

import { NextResponse, type NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";
import { canCallerAssignRole } from "@/lib/enterprise/invitations";
import {
  assertActorMayManage,
  MembershipGuardError,
} from "@/lib/enterprise/membership-guards";

export async function GET(
  _req: NextRequest,
  {
    params,
  }: {
    params: Promise<{ orgId: string; invitationId: string }>;
  },
) {
  const { orgId, invitationId } = await params;
  const access = await requireOrgAccess(orgId, {
    readOnly: true,
    permission: "invitations.manage",
  });
  if (access.error) return access.error;

  const invitation = await prisma.invitation.findFirst({
    where: { id: invitationId, organizationId: orgId },
  });
  if (!invitation) {
    return NextResponse.json(
      { error: "Invitation not found" },
      { status: 404 },
    );
  }
  return NextResponse.json({ invitation });
}

export async function DELETE(
  _req: NextRequest,
  {
    params,
  }: {
    params: Promise<{ orgId: string; invitationId: string }>;
  },
) {
  const { orgId, invitationId } = await params;
  const access = await requireOrgAccess(orgId, {
    permission: "invitations.manage",
    expectUser: true,
    // Unverified orgs may revoke founding-team invitations (requireActive: true omitted; SUSPENDED rejected below).
  });
  if (access.error) return access.error;
  if (access.org?.status === "SUSPENDED") {
    return NextResponse.json(
      {
        error: "ORG_NOT_ACTIVE",
        message:
          "Invitations cannot be modified while the organization is suspended.",
        status: access.org.status,
      },
      { status: 409 },
    );
  }

  try {
    // Conditional update: only pending invitations are revocable. An
    // already-accepted or already-canceled row is left untouched so the
    // audit log doesn't double-emit REVOKE on retry.
    const result = await prisma.$transaction(async (tx) => {
      const existing = await tx.invitation.findFirst({
        where: { id: invitationId, organizationId: orgId },
        select: { role: true, status: true },
      });
      if (!existing) return "not_found" as const;
      if (
        existing.status === "PENDING" &&
        !canCallerAssignRole(access.member.role, existing.role)
      ) {
        assertActorMayManage(
          {
            kind: "member",
            membershipId: access.member.id,
            role: access.member.role,
          },
          existing.role,
        );
      }

      const updated = await tx.invitation.updateMany({
        where: {
          id: invitationId,
          organizationId: orgId,
          status: "PENDING",
        },
        data: { status: "CANCELED" },
      });
      if (updated.count === 0) return "not_pending" as const;

      await tx.orgAuditLog.create({
        data: {
          organizationId: orgId,
          actorMembershipId: access.member.id,
          category: "MEMBER",
          action: AUDIT_ACTIONS.MEMBER.INVITE_REVOKED,
          description: `Revoked invitation ${invitationId}`,
          details: { invitationId },
        },
      });
      return "revoked" as const;
    });

    if (result === "not_found") {
      return NextResponse.json(
        { error: "Invitation not found" },
        { status: 404 },
      );
    }
    if (result === "not_pending") {
      return NextResponse.json(
        {
          error: "Invitation not pending (may already be accepted or canceled)",
        },
        { status: 409 },
      );
    }
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    if (err instanceof MembershipGuardError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.httpStatus },
      );
    }
    throw err;
  }
}
