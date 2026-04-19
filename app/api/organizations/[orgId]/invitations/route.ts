/**
 * GET  /api/organizations/[orgId]/invitations
 * POST /api/organizations/[orgId]/invitations
 *
 * Backed by BetterAuth's `Invitation` table — we keep the invitation
 * token lifecycle inside BetterAuth so the accept flow can verify the
 * token natively. The typed `Membership` row is created separately at
 * accept time (see /api/organizations/invitations/accept/route.ts).
 *
 * Self-service cannot invite into EXPERT or SUPPORT roles. EXPERT
 * requires canHost=true and the apply flow, SUPPORT is assigned from
 * Settings by an OWNER. The guard lives in the Zod schema.
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import crypto from "node:crypto";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";

// Subset of MemberRole an inviter can assign without elevated flows.
// Mirrors SELF_SERVICE_MEMBER_ROLES in lib/labels/org-labels.ts — two
// places because this is the server-side enforcement and the UI
// subset should never drift from the API subset.
const InvitableRoleSchema = z.enum([
  "OWNER",
  "MAINTAINER",
  "MANAGER",
  "LEARNER",
]);

const InviteBodySchema = z.object({
  email: z.string().email(),
  role: InvitableRoleSchema,
  // Default expiry: 14 days. Overridable up to 30 to avoid long-lived
  // invite tokens sitting in inboxes indefinitely.
  expiresInDays: z.coerce.number().int().min(1).max(30).default(14),
});

const StatusFilterSchema = z.enum([
  "pending",
  "accepted",
  "rejected",
  "expired",
  "canceled",
]);

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const access = await requireOrgAccess(orgId, "MAINTAINER");
  if (access.error) return access.error;

  const url = new URL(req.url);
  const rawStatus = url.searchParams.get("status");
  const status = rawStatus
    ? StatusFilterSchema.safeParse(rawStatus)
    : null;

  const invitations = await prisma.invitation.findMany({
    where: {
      organizationId: orgId,
      ...(status?.success ? { status: status.data } : {}),
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      email: true,
      role: true,
      status: true,
      expiresAt: true,
      createdAt: true,
      inviterId: true,
    },
  });

  return NextResponse.json({ data: invitations });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  // Invitations require an ACTIVE org. Pre-verification we return
  // 409 ORG_NOT_VERIFIED instead of spawning orphan tokens that
  // would never get an email sent. The UI banner explains the state.
  const access = await requireOrgAccess(orgId, {
    minimumRole: "MAINTAINER",
    requireActive: true,
  });
  if (access.error) return access.error;

  const raw = await req.json().catch(() => null);
  const parsed = InviteBodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body", detail: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const { email, role, expiresInDays } = parsed.data;

  // De-dupe active invitations by (orgId, email). An inviter retrying
  // from the UI shouldn't spawn two tokens that both resolve to the
  // same membership — the second POST updates the expiry instead.
  const existing = await prisma.invitation.findFirst({
    where: {
      organizationId: orgId,
      email,
      status: "pending",
    },
  });

  const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000);

  const invitation = await prisma.$transaction(async (tx) => {
    const token = existing?.id ?? crypto.randomUUID();
    const record = existing
      ? await tx.invitation.update({
          where: { id: existing.id },
          data: { role, expiresAt },
        })
      : await tx.invitation.create({
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

    await tx.orgAuditLog.create({
      data: {
        organizationId: orgId,
        actorMembershipId: access.member.id,
        category: "MEMBER",
        action: existing
          ? "INVITE_RESENT"
          : AUDIT_ACTIONS.MEMBER.INVITE_SENT,
        description: `${existing ? "Re-sent" : "Sent"} invite to ${email} as ${role}`,
        details: { email, role, expiresAt: expiresAt.toISOString() },
      },
    });

    return record;
  });

  return NextResponse.json({ invitation }, { status: existing ? 200 : 201 });
}
