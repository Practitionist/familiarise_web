/**
 * Just-in-time org membership for SSO sign-ins, called from the sso()
 * plugin's `provisionUser` on every login before the cookie is set. Any
 * existing row (REMOVED and SUSPENDED included) is left alone, so the IdP never
 * undoes an admin's removal. A pending invitation for the email supplies the
 * role and is marked accepted in the same transaction.
 */

import { Prisma, type MemberRole } from "@prisma/client";
import prisma from "@/lib/prisma";
import { applyMembershipRoleEffects } from "@/lib/api/organizations/membership-transitions";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";
import { UNVERIFIED_ORG_SEAT_CAP } from "@/lib/enterprise/governance";
import { dispatchWebhookEvent } from "@/lib/enterprise/outbound-webhooks/dispatch";
import { recordSystemEvent } from "@/lib/enterprise/system-events";
import { withSerializableRetry } from "@/lib/db/serializable-retry";

export type SsoJitInput = {
  userId: string;
  email: string;
  providerId: string;
  /** `SsoProvider.organizationId` of the provider the user signed in with. */
  organizationId: string | null | undefined;
};

export type SsoJitSkipReason =
  | "PROVIDER_WITHOUT_ORGANIZATION"
  | "ORGANIZATION_NOT_FOUND"
  | "ORGANIZATION_INACTIVE"
  | "SEAT_CAP_REACHED";

export type SsoJitOutcome =
  | { kind: "joined"; organizationId: string; role: MemberRole }
  | { kind: "already_member"; organizationId: string }
  | { kind: "skipped"; reason: SsoJitSkipReason };

const DEFAULT_JIT_ROLE: MemberRole = "LEARNER";

export async function provisionSsoMembership(
  input: SsoJitInput,
): Promise<SsoJitOutcome> {
  const { userId, providerId, organizationId } = input;

  if (!organizationId) {
    await recordSystemEvent({
      category: "SSO",
      severity: "WARN",
      message: `JIT auto-join skipped: SSO provider ${providerId} has no organization`,
      context: { userId, providerId },
    });
    return { kind: "skipped", reason: "PROVIDER_WITHOUT_ORGANIZATION" };
  }

  const existing = await prisma.membership.findUnique({
    where: { userId_organizationId: { userId, organizationId } },
    select: { id: true },
  });
  if (existing) return { kind: "already_member", organizationId };

  const org = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: {
      status: true,
      ssoSettings: { select: { defaultRoleForAutoJoin: true } },
    },
  });
  if (!org) {
    await recordSystemEvent({
      category: "SSO",
      severity: "WARN",
      message: `JIT auto-join skipped: SSO provider ${providerId} points at missing organization ${organizationId}`,
      context: { userId, providerId, organizationId },
    });
    return { kind: "skipped", reason: "ORGANIZATION_NOT_FOUND" };
  }

  const orgStatus = org.status;
  if (orgStatus === "SUSPENDED" || orgStatus === "DEACTIVATED") {
    await recordSystemEvent({
      organizationId,
      category: "SSO",
      severity: "WARN",
      message: `JIT auto-join skipped: organization is ${orgStatus} and the lifecycle gate refused membership creation for user ${userId}`,
      context: { userId, providerId, organizationStatus: orgStatus },
    });
    return { kind: "skipped", reason: "ORGANIZATION_INACTIVE" };
  }

  const defaultRole =
    org.ssoSettings?.defaultRoleForAutoJoin ?? DEFAULT_JIT_ROLE;
  const email = input.email.toLowerCase();

  try {
    const role = await withSerializableRetry(() =>
      prisma.$transaction(
        async (tx): Promise<MemberRole | null> => {
          if (orgStatus === "PENDING_VERIFICATION") {
            const activeMembers = await tx.membership.count({
              where: { organizationId, status: "ACTIVE" },
            });
            if (activeMembers >= UNVERIFIED_ORG_SEAT_CAP) return null;
          }

          const invitation = await tx.invitation.findFirst({
            where: {
              organizationId,
              email,
              status: "PENDING",
              expiresAt: { gt: new Date() },
            },
            orderBy: { createdAt: "desc" },
            select: { id: true, role: true },
          });
          const claimed = invitation
            ? await tx.invitation.updateMany({
                where: { id: invitation.id, status: "PENDING" },
                data: { status: "ACCEPTED", userId },
              })
            : { count: 0 };
          const joinRole =
            invitation && claimed.count === 1 ? invitation.role : defaultRole;
          const invitationId = claimed.count === 1 ? invitation?.id : undefined;

          // Creates the profile the role needs in this same transaction.
          const roleEffects = await applyMembershipRoleEffects(tx, {
            userId,
            role: joinRole,
          });
          const created = await tx.membership.create({
            data: {
              userId,
              organizationId,
              role: joinRole,
              status: "ACTIVE",
              consulteeProfileId: roleEffects.consulteeProfileId,
              consultantProfileId: roleEffects.consultantProfileId,
              payoutRecipient: roleEffects.payoutRecipient,
            },
          });
          await tx.orgAuditLog.create({
            data: {
              organizationId,
              targetMembershipId: created.id,
              category: "MEMBER",
              action: invitationId
                ? AUDIT_ACTIONS.MEMBER.INVITE_ACCEPTED
                : AUDIT_ACTIONS.MEMBER.MEMBER_ADDED,
              description: invitationId
                ? `Invitation accepted via SSO sign-in (${joinRole})`
                : `Member joined via SSO auto-join (${joinRole})`,
              details: {
                userId,
                providerId,
                role: joinRole,
                source: "SSO_JIT",
                ...(invitationId && { invitationId }),
              },
            },
          });
          await dispatchWebhookEvent({
            prisma: tx,
            organizationId,
            eventType: "member.added",
            payload: {
              membershipId: created.id,
              userId,
              role: joinRole,
              source: "SSO_JIT",
            },
          });
          return joinRole;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    );

    if (!role) {
      await recordSystemEvent({
        organizationId,
        category: "SSO",
        severity: "WARN",
        message: `JIT auto-join skipped: organization is ${orgStatus} and the seat/cap gate refused membership creation for user ${userId}`,
        context: { userId, providerId, organizationStatus: orgStatus },
      });
      return { kind: "skipped", reason: "SEAT_CAP_REACHED" };
    }
    return { kind: "joined", organizationId, role };
  } catch (err) {
    // A concurrent login won the (userId, organizationId) unique.
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      return { kind: "already_member", organizationId };
    }
    throw err;
  }
}
