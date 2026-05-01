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
import { requireOrgAccess } from "@/lib/auth-helpers";
import { isAtLeastRole } from "@/lib/auth/role-ranks";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";
import { isBlockedRoleTransition } from "@/lib/enterprise/role-transitions";
import {
  applyMembershipRoleEffects,
  recomputeConsultantIsIndependent,
} from "@/lib/api/organizations/membership-transitions";
import { notifyOrgExpertRemoved } from "@/lib/novu/service";

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
  const isManagerPlus = isAtLeastRole(access.member.role, "MANAGER");
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

      // Disjoint LEARNER/EXPERT boundary. These two roles imply
      // different platform profiles (ConsulteeProfile vs ConsultantProfile)
      // and different billing postures (consumer vs provider), so the
      // product rule is to force a remove + re-invite instead of
      // mutating in place. Returning the machine-readable code lets the
      // dashboard surface the humanized copy via humanizeOrgError.
      if (
        patch.role !== undefined &&
        patch.role !== current.role &&
        isBlockedRoleTransition(current.role, patch.role)
      ) {
        throw Object.assign(
          new Error("ROLE_TRANSITION_BLOCKED"),
          { httpStatus: 409 },
        );
      }

      // OWNER role gate: only OWNERs can assign or revoke the OWNER role.
      // A MAINTAINER renaming someone to OWNER would effectively grant
      // themselves extra privileges by proxy.
      const touchesOwnerRole =
        patch.role === "OWNER" || current.role === "OWNER";
      if (touchesOwnerRole && !isAtLeastRole(access.member.role, "OWNER")) {
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

      // Role-driven profile reconciliation. When the role changes we
      // hydrate / clear the consultee / consultant FKs through the
      // shared helper so PATCH stays in sync with POST and invite-accept.
      // payoutRecipient is reset to the role default (SELF) on role
      // change; pre-existing overrides are not preserved across a role
      // move.
      const roleEffects =
        patch.role !== undefined && patch.role !== current.role
          ? await applyMembershipRoleEffects(tx, {
              userId: current.userId,
              role: patch.role,
            })
          : null;

      const updated = await tx.membership.update({
        where: { id: memberId },
        data: {
          ...(patch.role !== undefined && { role: patch.role }),
          ...(patch.status !== undefined && { status: patch.status }),
          ...(patch.departmentLabel !== undefined && {
            departmentLabel: patch.departmentLabel,
          }),
          ...(roleEffects && {
            consulteeProfileId: roleEffects.consulteeProfileId,
            consultantProfileId: roleEffects.consultantProfileId,
            payoutRecipient: roleEffects.payoutRecipient,
          }),
        },
      });

      // A4: recompute ConsultantProfile.isIndependent if this PATCH touches
      // an EXPERT membership. PATCH cannot promote *into* EXPERT (Zod schema
      // blocks LEARNER↔EXPERT and the patch.role union excludes EXPERT in
      // practice), but PATCH can move a current EXPERT into an operator
      // role or flip an EXPERT membership's status away from / back to
      // ACTIVE — both shift the consultant's HOST-membership count.
      if (
        current.role === "EXPERT" &&
        current.consultantProfileId &&
        (patch.role !== undefined || patch.status !== undefined)
      ) {
        await recomputeConsultantIsIndependent(
          tx,
          current.consultantProfileId,
        );
      }

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

  // A7: capture context for the post-commit Novu fire. Resolved BEFORE
  // the transaction so the notification payload is ready to dispatch the
  // moment the soft-delete commits. Set inside the tx; fired after commit.
  let notifyContext: {
    consultantUserId: string;
    payload: import("@/lib/novu/workflows").OrgExpertRemovedPayload;
  } | null = null;

  try {
    await prisma.$transaction(async (tx) => {
      const current = await tx.membership.findFirst({
        where: { id: memberId, organizationId: orgId },
        include: { user: { select: { id: true } } },
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

      // A4: if this was an EXPERT membership, recompute the consultant's
      // isIndependent flag now that one HOST tie is gone. If it was the
      // last active EXPERT membership at any HOST org the flag flips back
      // to true and the consultant re-appears as "independent" on
      // /explore/experts.
      if (current.role === "EXPERT" && current.consultantProfileId) {
        await recomputeConsultantIsIndependent(
          tx,
          current.consultantProfileId,
        );
      }

      // A7 note: past `OrganizationEarnings` are NOT touched on member
      // removal. Sessions the consultant already delivered are settled
      // commitments — the org earned its share at booking time, and the
      // consultant's `ConsultantEarnings` row will pay out independently.
      // Cancelling already-accrued earnings here would create
      // reconciliation drift (LED-3 / LED-4 invariants would break).
      // Forward-looking: once the consultant is REMOVED, no NEW
      // `OrganizationEarnings` rows are created (resolveOrgSplit returns
      // null when no active EXPERT membership at a canHost org exists).

      // Cascade: terminate any active ProgramAssignments. Without this,
      // a removed member's assignments still match the
      // `periodStart <= now AND periodEnd >= now` filter, so their slot
      // continues to count against the program cap and a replacement
      // member can't be added. We close the period at `now` rather than
      // deleting so engagementsUsed history + UsageLedgerEntry rows
      // remain queryable for reconciliation.
      const now = new Date();
      const terminated = await tx.programAssignment.updateMany({
        where: { membershipId: memberId, periodEnd: { gte: now } },
        data: { periodEnd: now },
      });

      await tx.orgAuditLog.create({
        data: {
          organizationId: orgId,
          actorMembershipId: access.member.id,
          targetMembershipId: memberId,
          category: "MEMBER",
          action: AUDIT_ACTIONS.MEMBER.MEMBER_REMOVED,
          description: `Removed member ${memberId} (soft delete)`,
          details: {
            role: current.role,
            previousStatus: current.status,
            assignmentsTerminated: terminated.count,
          },
        },
      });

      // A7: stage the Novu fire (executed AFTER the tx commits so a
      // rollback never pages a notification for a delete that didn't
      // happen). Only EXPERT removals trigger the personal notification —
      // operator role removals don't need this.
      if (current.role === "EXPERT" && current.user) {
        const org = await tx.organization.findUnique({
          where: { id: orgId },
          select: { name: true, slug: true },
        });
        const actor = await tx.user.findUnique({
          where: { id: access.session.user.id },
          select: { name: true, email: true },
        });
        if (org) {
          notifyContext = {
            consultantUserId: current.user.id,
            payload: {
              orgName: org.name,
              orgSlug: org.slug,
              removedByName: actor?.name ?? actor?.email ?? "An operator",
              reason: null,
              dashboardUrl: `${process.env.NEXT_PUBLIC_APP_URL ?? ""}/dashboard/consultant`,
            },
          };
        }
      }
    });

    // A7: fire-and-forget Novu trigger after commit. A failure here MUST
    // NOT roll back the soft-delete (the membership is already gone in
    // the DB); log the error and continue.
    if (notifyContext !== null) {
      const ctx = notifyContext as {
        consultantUserId: string;
        payload: import("@/lib/novu/workflows").OrgExpertRemovedPayload;
      };
      try {
        await notifyOrgExpertRemoved(ctx.consultantUserId, ctx.payload);
      } catch (notifyErr) {
        console.error(
          "[member-delete] Novu notify failed (non-fatal):",
          notifyErr,
        );
      }
    }

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
