/**
 * GET    /api/organizations/[orgId]/members/[memberId]
 * PATCH  /api/organizations/[orgId]/members/[memberId]
 * DELETE /api/organizations/[orgId]/members/[memberId]
 *
 * `memberId` is a `Membership.id` (not a User id). Operations produce an
 * audit log row in the same transaction as the mutation.
 *
 * Last-OWNER safety: the API refuses to demote or remove the only active
 * OWNER so an org can never end up ownerless. The check runs inside the
 * transaction so a concurrent second request can't race past it.
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { requireOrgAccess, orgRoleSatisfies } from "@/lib/auth-helpers";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";

const MemberRoleSchema = z.enum([
  "OWNER",
  "MAINTAINER",
  "MANAGER",
  "EXPERT",
  "LEARNER",
  "SUPPORT",
]);

const MemberStatusSchema = z.enum(["PENDING", "ACTIVE", "SUSPENDED", "REMOVED"]);

const PatchBodySchema = z
  .object({
    role: MemberRoleSchema.optional(),
    status: MemberStatusSchema.optional(),
    departmentLabel: z.string().max(100).nullable().optional(),
  })
  .refine(
    (v) =>
      v.role !== undefined ||
      v.status !== undefined ||
      v.departmentLabel !== undefined,
    { message: "PATCH body must contain at least one of role/status/departmentLabel" },
  );

export async function GET(
  _req: NextRequest,
  {
    params,
  }: {
    params: Promise<{ orgId: string; memberId: string }>;
  },
) {
  const { orgId, memberId } = await params;
  // MANAGER+ can read other members' details. LEARNER+SUPPORT can only
  // fetch THEIR OWN membership — otherwise any member of the org could
  // enumerate peers' emails/names/profile ids. Member-list (index) view
  // remains separately gated; this is the detail endpoint.
  const access = await requireOrgAccess(orgId);
  if (access.error) return access.error;

  const membership = await prisma.membership.findFirst({
    where: { id: memberId, organizationId: orgId },
    include: {
      user: {
        select: { id: true, name: true, email: true, image: true },
      },
      consulteeProfile: { select: { id: true } },
      consultantProfile: { select: { id: true } },
    },
  });
  if (!membership) {
    return NextResponse.json({ error: "Member not found" }, { status: 404 });
  }

  const isSelf = membership.id === access.member.id;
  const isManagerPlus = orgRoleSatisfies(access.member.role, "MANAGER");
  if (!isSelf && !isManagerPlus) {
    return NextResponse.json(
      { error: "Insufficient role to view other members" },
      { status: 403 },
    );
  }

  return NextResponse.json({ membership });
}

export async function PATCH(
  req: NextRequest,
  {
    params,
  }: {
    params: Promise<{ orgId: string; memberId: string }>;
  },
) {
  const { orgId, memberId } = await params;
  const access = await requireOrgAccess(orgId, "MAINTAINER");
  if (access.error) return access.error;

  const raw = await req.json().catch(() => null);
  const parsed = PatchBodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body", detail: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const patch = parsed.data;

  try {
    const result = await prisma.$transaction(async (tx) => {
      const current = await tx.membership.findFirst({
        where: { id: memberId, organizationId: orgId },
      });
      if (!current) {
        throw Object.assign(new Error("Member not found"), { httpStatus: 404 });
      }

      // OWNER role gate: only OWNERs can assign or revoke the OWNER role.
      // A MAINTAINER renaming someone to OWNER would effectively grant
      // themselves extra privileges by proxy.
      const touchesOwnerRole =
        patch.role === "OWNER" || current.role === "OWNER";
      if (touchesOwnerRole && !orgRoleSatisfies(access.member.role, "OWNER")) {
        throw Object.assign(
          new Error("Only an OWNER can assign or revoke the OWNER role"),
          { httpStatus: 403 },
        );
      }

      // Last-OWNER guard. Runs inside the TX so two concurrent demotes
      // can't both believe there's a second owner.
      const isDemotingOwner =
        current.role === "OWNER" &&
        patch.role !== undefined &&
        patch.role !== "OWNER";
      const isRemovingOwner =
        current.role === "OWNER" && patch.status === "REMOVED";
      if (isDemotingOwner || isRemovingOwner) {
        const activeOwnerCount = await tx.membership.count({
          where: {
            organizationId: orgId,
            role: "OWNER",
            status: "ACTIVE",
            id: { not: memberId },
          },
        });
        if (activeOwnerCount === 0) {
          throw Object.assign(
            new Error(
              "Cannot demote or remove the only active OWNER. Promote another member to OWNER first.",
            ),
            { httpStatus: 409 },
          );
        }
      }

      const updated = await tx.membership.update({
        where: { id: memberId },
        data: {
          ...(patch.role !== undefined && { role: patch.role }),
          ...(patch.status !== undefined && { status: patch.status }),
          ...(patch.departmentLabel !== undefined && {
            departmentLabel: patch.departmentLabel,
          }),
        },
      });

      const auditActions: string[] = [];
      if (patch.role !== undefined && patch.role !== current.role) {
        auditActions.push(AUDIT_ACTIONS.MEMBER.ROLE_CHANGE);
      }
      if (patch.status !== undefined && patch.status !== current.status) {
        auditActions.push(AUDIT_ACTIONS.MEMBER.STATUS_CHANGE);
      }
      for (const action of auditActions) {
        await tx.orgAuditLog.create({
          data: {
            organizationId: orgId,
            actorMembershipId: access.member.id,
            targetMembershipId: memberId,
            category: "MEMBER",
            action,
            description:
              action === AUDIT_ACTIONS.MEMBER.ROLE_CHANGE
                ? `Role: ${current.role} → ${patch.role}`
                : `Status: ${current.status} → ${patch.status}`,
            details: {
              from: {
                role: current.role,
                status: current.status,
              },
              to: {
                role: patch.role ?? current.role,
                status: patch.status ?? current.status,
              },
            },
          },
        });
      }

      return updated;
    });

    return NextResponse.json({ membership: result });
  } catch (err) {
    // Structured error handling keeps the switch between 404/403/409
    // explicit — never leak a 500 for user-facing validation issues.
    if (err instanceof Error && "httpStatus" in err) {
      const status =
        typeof err.httpStatus === "number" ? err.httpStatus : 500;
      return NextResponse.json({ error: err.message }, { status });
    }
    throw err;
  }
}

export async function DELETE(
  _req: NextRequest,
  {
    params,
  }: {
    params: Promise<{ orgId: string; memberId: string }>;
  },
) {
  const { orgId, memberId } = await params;
  const access = await requireOrgAccess(orgId, "MAINTAINER");
  if (access.error) return access.error;

  try {
    await prisma.$transaction(async (tx) => {
      const current = await tx.membership.findFirst({
        where: { id: memberId, organizationId: orgId },
      });
      if (!current) {
        throw Object.assign(new Error("Member not found"), { httpStatus: 404 });
      }

      if (current.role === "OWNER") {
        // Last-OWNER guard — unchanged semantically. Now applied to
        // soft-delete (status → REMOVED) so a sole OWNER can't orphan
        // the org by removing themselves.
        const activeOwnerCount = await tx.membership.count({
          where: {
            organizationId: orgId,
            role: "OWNER",
            status: "ACTIVE",
            id: { not: memberId },
          },
        });
        if (activeOwnerCount === 0) {
          throw Object.assign(
            new Error(
              "Cannot remove the only active OWNER. Promote another member first.",
            ),
            { httpStatus: 409 },
          );
        }
      }

      if (current.status === "REMOVED") {
        // Idempotent: a repeat DELETE is a no-op that still returns 204.
        return;
      }

      // Soft-delete (status=REMOVED) instead of hard-delete: audit rows
      // reference Membership via `actorMembershipId`/`targetMembershipId`,
      // payouts, earnings, and wallet entries do too. A hard delete
      // would cascade across half the compliance tables. REMOVED is a
      // tombstone — it hides the row from all listing endpoints, blocks
      // login attempts, but keeps the history queryable.
      await tx.membership.update({
        where: { id: memberId },
        data: { status: "REMOVED" },
      });
      await tx.orgAuditLog.create({
        data: {
          organizationId: orgId,
          actorMembershipId: access.member.id,
          targetMembershipId: memberId,
          category: "MEMBER",
          action: AUDIT_ACTIONS.MEMBER.MEMBER_REMOVED,
          description: `Removed member ${memberId} (soft delete)`,
          details: { role: current.role, previousStatus: current.status },
        },
      });
    });

    return new NextResponse(null, { status: 204 });
  } catch (err) {
    if (err instanceof Error && "httpStatus" in err) {
      const status =
        typeof err.httpStatus === "number" ? err.httpStatus : 500;
      return NextResponse.json({ error: err.message }, { status });
    }
    throw err;
  }
}
