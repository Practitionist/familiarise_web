/**
 * Organization invitations — GET (list) / POST (create).
 *
 * Invitations target an email address that may or may not have a platform
 * account yet. The invited user accepts via /api/organizations/invitations/accept
 * which creates the Member + OrganizationMemberProfile rows.
 *
 * Auth:
 *   GET  — any active org member
 *   POST — ORG_ADMIN+
 *
 * ORG_CONSULTANT and ORG_SUPPORT roles in the invite are gated by
 * ENABLE_PROVIDER_ORGS. Email delivery is fire-and-forget — failure to send
 * does not roll back the invitation row (the org admin can resend).
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { ENABLE_PROVIDER_ORGS } from "@/lib/feature-flags";
import { OrgMemberRole } from "@prisma/client";

const inviteSchema = z.object({
  email: z.string().email(),
  role: z.nativeEnum(OrgMemberRole).default("ORG_LEARNER"),
});

const PROVIDER_GATED_ROLES: OrgMemberRole[] = ["ORG_CONSULTANT", "ORG_SUPPORT"];

const INVITATION_TTL_DAYS = 14;

function makeInviteToken(): string {
  // Cryptographically random 32-byte token, hex-encoded.
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  try {
    const { orgId } = await params;
    const access = await requireOrgAccess(orgId);
    if (access.error) return access.error;

    const invitations = await prisma.invitation.findMany({
      where: { organizationId: orgId },
      include: {
        inviter: { select: { id: true, name: true, email: true } },
      },
      orderBy: { createdAt: "desc" },
    });

    return NextResponse.json({ invitations });
  } catch (error) {
    console.error(
      "[API /organizations/[orgId]/invitations GET] error:",
      error,
    );
    return NextResponse.json(
      { error: "Failed to fetch invitations" },
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
    const parsed = inviteSchema.safeParse(body);
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

    // Reject duplicate pending invites for the same (org, email) pair.
    const existing = await prisma.invitation.findFirst({
      where: { organizationId: orgId, email, status: "pending" },
    });
    if (existing) {
      return NextResponse.json(
        { error: "An invitation for this email is already pending." },
        { status: 409 },
      );
    }

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + INVITATION_TTL_DAYS);

    // BetterAuth Invitation.id is a CUID — we use it as the accept token.
    // We pass an explicit id so we control the token without an extra column.
    const token = makeInviteToken();

    const invitation = await prisma.invitation.create({
      data: {
        id: token,
        organizationId: orgId,
        email,
        role,
        status: "pending",
        expiresAt,
        inviterId: access.session.user.id,
      },
    });

    // TODO(Phase H/email): wire up Resend transactional template
    // ("you're invited to join {orgName}") with the accept link
    // `${BASE_URL}/organizations/invite/${invitation.id}`.

    return NextResponse.json({ invitation }, { status: 201 });
  } catch (error) {
    console.error(
      "[API /organizations/[orgId]/invitations POST] error:",
      error,
    );
    return NextResponse.json(
      { error: "Failed to create invitation" },
      { status: 500 },
    );
  }
}
