/**
 * Accept an organization invitation.
 *
 * POST { token } — looks up the Invitation row, verifies it's pending and
 * unexpired, and creates the Member + OrganizationMemberProfile rows for the
 * authenticated caller. The caller's email must match the invited email.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { requireApiAuth } from "@/lib/auth-helpers";
import { ENABLE_PROVIDER_ORGS } from "@/lib/feature-flags";
import { acquireSeat } from "@/lib/api/organizations/seat-helpers";
import { OrgAuditAction, OrgMemberRole } from "@prisma/client";

const acceptSchema = z.object({
  token: z.string().min(16),
});

const PROVIDER_GATED_ROLES: OrgMemberRole[] = ["ORG_CONSULTANT", "ORG_SUPPORT"];

function coerceOrgMemberRole(raw: string): OrgMemberRole {
  // Defensive: invitations created via BetterAuth's UI may carry "member" /
  // "owner" / "admin" string values. Map them onto our typed enum.
  if (raw in OrgMemberRole) return raw as OrgMemberRole;
  switch (raw.toLowerCase()) {
    case "owner":
      return "ORG_OWNER";
    case "admin":
      return "ORG_ADMIN";
    case "manager":
      return "ORG_MANAGER";
    case "member":
    case "learner":
    default:
      return "ORG_LEARNER";
  }
}

export async function POST(req: NextRequest) {
  try {
    const auth = await requireApiAuth();
    if (auth.error) return auth.error;

    const body = await req.json();
    const parsed = acceptSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request body", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const invitation = await prisma.invitation.findUnique({
      where: { id: parsed.data.token },
      include: {
        organization: {
          select: { id: true, name: true, organizationProfile: true },
        },
      },
    });

    if (!invitation) {
      return NextResponse.json(
        { error: "Invitation not found" },
        { status: 404 },
      );
    }
    if (invitation.status !== "pending") {
      return NextResponse.json(
        { error: `Invitation is ${invitation.status}` },
        { status: 400 },
      );
    }
    if (invitation.expiresAt < new Date()) {
      return NextResponse.json(
        { error: "Invitation has expired" },
        { status: 400 },
      );
    }
    if (
      invitation.email.toLowerCase() !==
      auth.session.user.email.toLowerCase()
    ) {
      return NextResponse.json(
        { error: "This invitation was sent to a different email address." },
        { status: 403 },
      );
    }
    if (!invitation.organization.organizationProfile) {
      return NextResponse.json(
        { error: "Organization profile is missing — contact support." },
        { status: 500 },
      );
    }

    const role = coerceOrgMemberRole(invitation.role);
    if (!ENABLE_PROVIDER_ORGS && PROVIDER_GATED_ROLES.includes(role)) {
      return NextResponse.json(
        {
          error: `${role} role is gated behind PROVIDER orgs.`,
          flag: "ENABLE_PROVIDER_ORGS",
        },
        { status: 501 },
      );
    }

    const orgProfile = invitation.organization.organizationProfile;
    const userId = auth.session.user.id;

    // Idempotent: if a Member already exists, surface that.
    const existing = await prisma.member.findUnique({
      where: {
        organizationId_userId: {
          organizationId: invitation.organizationId,
          userId,
        },
      },
    });
    if (existing) {
      await prisma.invitation.update({
        where: { id: invitation.id },
        data: { status: "accepted" },
      });
      return NextResponse.json({
        organization: {
          id: invitation.organization.id,
          name: invitation.organization.name,
        },
        alreadyMember: true,
      });
    }

    const consulteeProfileId = auth.session.user.consulteeProfileId ?? null;
    const consultantProfileId = auth.session.user.consultantProfileId ?? null;

    // Profile link guard — same check as the direct-add flow.
    if (role === "ORG_LEARNER" && !consulteeProfileId) {
      return NextResponse.json(
        { error: "Complete your learner profile before accepting this invitation." },
        { status: 422 },
      );
    }
    if (role === "ORG_CONSULTANT" && !consultantProfileId) {
      return NextResponse.json(
        { error: "Complete your consultant profile before accepting this invitation." },
        { status: 422 },
      );
    }

    await prisma.$transaction(async (tx) => {
      // Atomic status claim — prevents double-accept race.
      // The pre-TX status check is a fast-path for the common case; this guard
      // is the actual enforcement. Two concurrent accepts both pass the soft
      // check above; only the first updateMany wins (count=1), the second gets
      // count=0 and throws INVITATION_ALREADY_ACCEPTED.
      const claimed = await tx.invitation.updateMany({
        where: { id: invitation.id, status: "pending" },
        data: { status: "accepted" },
      });
      if (claimed.count === 0) throw new Error("INVITATION_ALREADY_ACCEPTED");

      // Atomic seat acquisition — conditional UPDATE prevents oversubscription.
      if (role === "ORG_LEARNER") {
        const acquired = await acquireSeat(tx, orgProfile.id);
        if (!acquired) throw new Error("SEAT_LIMIT_REACHED");
      }

      const member = await tx.member.create({
        data: {
          organizationId: invitation.organizationId,
          userId,
          role,
        },
      });

      const memberProfile = await tx.organizationMemberProfile.create({
        data: {
          memberId: member.id,
          organizationProfileId: orgProfile.id,
          role,
          status: "ACTIVE",
          consulteeProfileId:
            role === "ORG_LEARNER" ? consulteeProfileId : null,
          consultantProfileId:
            role === "ORG_CONSULTANT" ? consultantProfileId : null,
          seatAssignedAt: role === "ORG_LEARNER" ? new Date() : null,
        },
      });

      // Audit log — actor and target are the same person (self-join via invite).
      await tx.orgAuditLog.create({
        data: {
          organizationProfileId: orgProfile.id,
          actorMemberId: memberProfile.id,
          targetMemberId: memberProfile.id,
          action: OrgAuditAction.MEMBER_ADDED,
          description: `${auth.session.user.email} joined as ${role} via invitation`,
          details: { role, email: auth.session.user.email, viaInvitation: true },
        },
      });
    });

    return NextResponse.json({
      organization: {
        id: invitation.organization.id,
        name: invitation.organization.name,
      },
      role,
    });
  } catch (error) {
    if (error instanceof Error && error.message === "INVITATION_ALREADY_ACCEPTED") {
      return NextResponse.json(
        { error: "This invitation has already been accepted." },
        { status: 409 },
      );
    }
    if (error instanceof Error && error.message === "SEAT_LIMIT_REACHED") {
      return NextResponse.json(
        { error: "This organization has reached its seat limit. Contact the org admin." },
        { status: 403 },
      );
    }
    console.error("[API /organizations/invitations/accept POST] error:", error);
    return NextResponse.json(
      { error: "Failed to accept invitation" },
      { status: 500 },
    );
  }
}
