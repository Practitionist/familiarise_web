/**
 * POST /api/organizations/invitations/accept
 *
 * Accepts a pending BetterAuth `Invitation` by id and creates the typed
 * `Membership` row in the same transaction. Also creates the BetterAuth
 * `Member` sibling so BetterAuth's org-scoped session flows keep working
 * — the two tables are linked via `Membership.betterAuthMemberId`.
 *
 * Token race: two concurrent accepts from the same email could both pass
 * the pre-check. `updateMany WHERE status = pending` gives us an atomic
 * claim — only the first caller transitions the invitation to accepted,
 * the second sees count=0 and reports 409.
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { requireApiAuth } from "@/lib/auth-helpers";
import { MemberRoleSchema } from "@/lib/labels/org-labels";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";
import { ensureConsulteeProfile } from "@/lib/profiles/ensure-consultee-profile";
import { notifyOrgInviteAccepted } from "@/lib/novu/org-workflows";

const AcceptBodySchema = z.object({
  invitationId: z.string().min(1),
});

export async function POST(req: NextRequest) {
  const auth = await requireApiAuth();
  if (auth.error) return auth.error;

  const raw = await req.json().catch(() => null);
  const parsed = AcceptBodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body", detail: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const { invitationId } = parsed.data;

  // Verify the invitation against the authenticated user's email before
  // doing anything mutative. Preventing accept-by-id-guessing means a
  // stolen URL from a user's inbox still can't be redeemed by someone
  // else's account.
  const invitation = await prisma.invitation.findUnique({
    where: { id: invitationId },
    select: {
      id: true,
      organizationId: true,
      email: true,
      role: true,
      status: true,
      expiresAt: true,
    },
  });
  if (!invitation) {
    return NextResponse.json({ error: "Invitation not found" }, { status: 404 });
  }
  if (invitation.email.toLowerCase() !== auth.session.user.email.toLowerCase()) {
    return NextResponse.json(
      { error: "This invitation is not addressed to you" },
      { status: 403 },
    );
  }
  if (invitation.expiresAt.getTime() < Date.now()) {
    return NextResponse.json(
      { error: "Invitation has expired" },
      { status: 410 },
    );
  }

  // Narrow the stored string to a MemberRole. BetterAuth's Invitation
  // table stores role as a free-form string, so validate before using.
  const roleResult = MemberRoleSchema.safeParse(invitation.role);
  if (!roleResult.success) {
    return NextResponse.json(
      { error: `Unknown invitation role: ${invitation.role}` },
      { status: 400 },
    );
  }
  const normalizedRole = roleResult.data;

  const userId = auth.session.user.id;

  try {
    const result = await prisma.$transaction(async (tx) => {
      // Atomic claim — only the first concurrent accept wins. Follow-up
      // retries get count=0 and fall into the 409 branch below.
      const claim = await tx.invitation.updateMany({
        where: { id: invitationId, status: "pending" },
        data: { status: "accepted", userId },
      });
      if (claim.count === 0) {
        throw Object.assign(
          new Error("Invitation is no longer pending"),
          { httpStatus: 409 },
        );
      }

      const org = await tx.organization.findUnique({
        where: { id: invitation.organizationId },
        select: { id: true, name: true },
      });
      if (!org) {
        throw Object.assign(
          new Error("Organization no longer exists"),
          { httpStatus: 404 },
        );
      }

      // User may already have a Membership in this org from a direct
      // admin add or an SSO auto-join. Idempotent upsert keeps the
      // UI's "accept" button safe to click twice.
      const existing = await tx.membership.findUnique({
        where: {
          userId_organizationId: {
            userId,
            organizationId: invitation.organizationId,
          },
        },
      });
      if (existing) {
        return { membership: existing, organization: org, alreadyMember: true };
      }

      // Profile FK hydration. The rules are role-specific:
      //   LEARNER — ensure ConsulteeProfile exists (lazy-create if not),
      //             link via Membership.consulteeProfileId.
      //   EXPERT  — ensure ConsultantProfile exists (lazy-create with
      //             verificationStatus=PENDING if not), link via
      //             Membership.consultantProfileId. The org-issued
      //             ConsultantProfile mirrors the posture of the self-
      //             service apply flow: the profile is hidden from
      //             /explore/experts until a platform admin verifies.
      //   Other roles — no profile linkage (MAINTAINER, MANAGER, etc.).
      //
      // The same profile may be linked to memberships at several orgs
      // concurrently; the schema is deliberately many-to-many and
      // docs/enterprise/14-scenarios-and-examples.md lists multi-org
      // experts and learners as first-class cases.
      let consulteeProfileId: string | null = null;
      let consultantProfileId: string | null = null;

      if (normalizedRole === "LEARNER") {
        consulteeProfileId = await ensureConsulteeProfile(tx, userId);
      } else if (normalizedRole === "EXPERT") {
        const existing = await tx.user.findUnique({
          where: { id: userId },
          select: { consultantProfileId: true },
        });
        if (existing?.consultantProfileId) {
          consultantProfileId = existing.consultantProfileId;
        } else {
          // Org-invited EXPERTs don't pick a domain / schedule at
          // invitation accept time the way self-service apply-to-consult
          // does. Seed a minimal-but-valid profile with the "General"
          // placeholder domain + WEEKLY schedule so the Membership FK
          // can be satisfied. The user completes real domain + schedule
          // selection from the expert profile editor.
          //
          // verificationStatus defaults to PENDING_VERIFICATION, which
          // keeps the profile hidden from /explore/experts until a
          // platform admin reviews — matching the apply-flow posture.
          const placeholderDomain = await tx.domain.upsert({
            where: { name: "General" },
            create: { name: "General" },
            update: {},
            select: { id: true },
          });
          const created = await tx.consultantProfile.create({
            data: {
              userId,
              domainId: placeholderDomain.id,
              scheduleType: "WEEKLY",
            },
            select: { id: true },
          });
          await tx.user.updateMany({
            where: { id: userId, consultantProfileId: null },
            data: { consultantProfileId: created.id },
          });
          consultantProfileId = created.id;
        }
      }

      // BetterAuth Member row is kept for org-scoped session flows.
      // Membership.betterAuthMemberId preserves the linkage even after
      // BetterAuth's own adapter writes are done.
      const betterAuthMember = await tx.member.create({
        data: {
          organizationId: invitation.organizationId,
          userId,
          // BetterAuth's Member.role is a free-form string; we write the
          // typed MemberRole value here so third-party tools that read
          // the BetterAuth table see the correct role.
          role: normalizedRole,
        },
      });

      const created = await tx.membership.create({
        data: {
          userId,
          organizationId: invitation.organizationId,
          role: normalizedRole,
          status: "ACTIVE",
          consulteeProfileId,
          consultantProfileId,
          betterAuthMemberId: betterAuthMember.id,
        },
      });

      await tx.orgAuditLog.create({
        data: {
          organizationId: invitation.organizationId,
          actorMembershipId: created.id,
          targetMembershipId: created.id,
          category: "MEMBER",
          action: AUDIT_ACTIONS.MEMBER.INVITE_ACCEPTED,
          description: `User ${userId} accepted invitation to join as ${normalizedRole}`,
          details: { invitationId: invitation.id, role: normalizedRole },
        },
      });

      return { membership: created, organization: org, alreadyMember: false };
    });

    // Side-effect: notify the org's operator roster that someone new
    // joined. Skip when the caller was already a member — the "accept"
    // button was just idempotent, nothing newsworthy happened.
    if (!result.alreadyMember) {
      const origin = new URL(req.url).origin;
      notifyOrgInviteAccepted(result.organization.id, {
        accepteeName: auth.session.user.name ?? auth.session.user.email,
        accepteeEmail: auth.session.user.email,
        orgName: result.organization.name,
        role: result.membership.role,
        dashboardUrl: `${origin}/dashboard/organization/${result.organization.id}/members`,
      }).catch((err) =>
        console.error("[notifyOrgInviteAccepted] failed:", err),
      );
    }

    // Client contract (app/organizations/invite/[token]/page.tsx): expects
    //   { organization: { id, name }, role?: string, alreadyMember?: boolean }
    // so it can redirect to /dashboard/organization/:id/home after accept.
    // Returning a bare `{ membership }` silently broke the redirect.
    return NextResponse.json(
      {
        organization: result.organization,
        role: result.membership.role,
        alreadyMember: result.alreadyMember,
        membership: result.membership,
      },
      { status: result.alreadyMember ? 200 : 201 },
    );
  } catch (err) {
    if (err instanceof Error && "httpStatus" in err) {
      const status =
        typeof err.httpStatus === "number" ? err.httpStatus : 500;
      return NextResponse.json({ error: err.message }, { status });
    }
    throw err;
  }
}
