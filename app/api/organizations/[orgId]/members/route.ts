/**
 * Organization members — GET (list) / POST (add existing user).
 *
 * GET    — any active org member (read)
 * POST   — ORG_ADMIN+ (add by user email; user must already exist on the platform).
 *          For invites to non-platform users, use /invitations instead.
 *
 * ORG_CONSULTANT and ORG_SUPPORT roles are gated behind ENABLE_PROVIDER_ORGS.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { ENABLE_PROVIDER_ORGS } from "@/lib/feature-flags";
import { acquireSeat } from "@/lib/api/organizations/seat-helpers";
import { OrgMemberRole } from "@prisma/client";

const addMemberSchema = z.object({
  email: z.string().email(),
  role: z.nativeEnum(OrgMemberRole),
});

const PROVIDER_GATED_ROLES: OrgMemberRole[] = ["ORG_CONSULTANT", "ORG_SUPPORT"];

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  try {
    const { orgId } = await params;
    const access = await requireOrgAccess(orgId);
    if (access.error) return access.error;

    const members = await prisma.organizationMemberProfile.findMany({
      where: { organizationProfileId: access.org.id },
      include: {
        member: {
          include: {
            user: {
              select: {
                id: true,
                name: true,
                email: true,
                image: true,
              },
            },
          },
        },
      },
      orderBy: { createdAt: "asc" },
    });

    return NextResponse.json({
      members: members.map((m) => ({
        id: m.id,
        memberId: m.memberId,
        role: m.role,
        status: m.status,
        seatAssignedAt: m.seatAssignedAt,
        createdAt: m.createdAt,
        user: m.member.user,
      })),
    });
  } catch (error) {
    console.error("[API /organizations/[orgId]/members GET] error:", error);
    return NextResponse.json(
      { error: "Failed to fetch members" },
      { status: 500 },
    );
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  try {
    const { orgId } = await params;
    const access = await requireOrgAccess(orgId, "ORG_ADMIN");
    if (access.error) return access.error;

    const body = await req.json();
    const parsed = addMemberSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request body", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const { email, role } = parsed.data;

    if (!ENABLE_PROVIDER_ORGS && PROVIDER_GATED_ROLES.includes(role)) {
      return NextResponse.json(
        {
          error: `${role} role is gated behind PROVIDER orgs.`,
          flag: "ENABLE_PROVIDER_ORGS",
        },
        { status: 501 },
      );
    }

    const user = await prisma.user.findUnique({
      where: { email },
      select: { id: true, consultantProfileId: true, consulteeProfileId: true },
    });
    if (!user) {
      return NextResponse.json(
        { error: "No user with that email exists. Send an invitation instead." },
        { status: 404 },
      );
    }

    const existing = await prisma.member.findUnique({
      where: {
        organizationId_userId: { organizationId: orgId, userId: user.id },
      },
      include: { organizationMemberProfile: true },
    });

    // If a member row exists but the profile is REMOVED, reactivate instead of 409.
    const existingProfile = existing?.organizationMemberProfile ?? null;
    if (existing && existingProfile && existingProfile.status !== "REMOVED") {
      return NextResponse.json(
        { error: "User is already a member of this organization." },
        { status: 409 },
      );
    }

    const result = await prisma.$transaction(async (tx) => {
      // Atomic seat acquisition — the conditional UPDATE only succeeds when
      // capacity allows, eliminating the read-check-write race.
      if (role === "ORG_LEARNER") {
        const acquired = await acquireSeat(tx, access.org.id);
        if (!acquired) {
          throw new Error("SEAT_LIMIT_REACHED");
        }
      }

      let member;
      let memberProfile;

      if (existing && existingProfile?.status === "REMOVED") {
        // Reactivate: update the existing BetterAuth member role and the profile
        member = await tx.member.update({
          where: { id: existing.id },
          data: { role },
        });
        memberProfile = await tx.organizationMemberProfile.update({
          where: { id: existingProfile.id },
          data: {
            role,
            status: "ACTIVE",
            consulteeProfileId:
              role === "ORG_LEARNER" ? user.consulteeProfileId : null,
            consultantProfileId:
              role === "ORG_CONSULTANT" ? user.consultantProfileId : null,
            seatAssignedAt: role === "ORG_LEARNER" ? new Date() : null,
          },
        });
      } else {
        member = await tx.member.create({
          data: {
            organizationId: orgId,
            userId: user.id,
            role,
          },
        });
        memberProfile = await tx.organizationMemberProfile.create({
          data: {
            memberId: member.id,
            organizationProfileId: access.org.id,
            role,
            status: "ACTIVE",
            // ORG_LEARNER → link consultee profile (BUYER); ORG_CONSULTANT → link consultant profile (PROVIDER, gated)
            consulteeProfileId:
              role === "ORG_LEARNER" ? user.consulteeProfileId : null,
            consultantProfileId:
              role === "ORG_CONSULTANT" ? user.consultantProfileId : null,
            seatAssignedAt: role === "ORG_LEARNER" ? new Date() : null,
          },
        });
      }

      // seatsUsed already incremented by acquireSeat() above for ORG_LEARNER.

      return { member, memberProfile };
    });

    return NextResponse.json({ memberProfile: result.memberProfile }, { status: 201 });
  } catch (error) {
    if (error instanceof Error && error.message === "SEAT_LIMIT_REACHED") {
      return NextResponse.json(
        { error: "Organization has reached its seat limit. Remove a learner or increase the seat budget in Settings." },
        { status: 403 },
      );
    }
    console.error("[API /organizations/[orgId]/members POST] error:", error);
    return NextResponse.json(
      { error: "Failed to add member" },
      { status: 500 },
    );
  }
}
