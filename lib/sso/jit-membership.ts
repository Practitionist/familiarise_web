/**
 * Just-in-time org membership for SSO sign-ins.
 *
 * Called from the sso() plugin's `provisionUser` hook (lib/sso/plugin-options.ts)
 * after the IdP round trip has produced a user and a session, but before the
 * session cookie is set. It writes the typed `Membership` directly; there is
 * no intermediate BetterAuth `Member` row.
 *
 * Runs on every SSO login, not just the first: a user who already had a
 * password account links SSO without "registering", and a join refused by the
 * seat cap should succeed on a later login once a seat frees up. The existing-
 * row check makes the repeat cheap, and any existing row (REMOVED and
 * SUSPENDED included) is left alone so an admin's removal is never undone by
 * the IdP.
 *
 * Gates, all evaluated here, once, at sign-in:
 *   - the org must exist and not be SUSPENDED / DEACTIVATED;
 *   - a PENDING_VERIFICATION org admits at most UNVERIFIED_ORG_SEAT_CAP ACTIVE
 *     members, counted in the same Serializable transaction as the insert so
 *     two concurrent first logins cannot both take the last seat.
 * Skips are recorded as SSO system events so ops can see an IdP that is out of
 * step with the org's lifecycle.
 *
 * Errors other than "already a member" propagate. The plugin then fails the
 * callback before the cookie is set, so the user is never signed in without
 * the membership the IdP promised; the transaction means a failure leaves no
 * partial profile or membership behind, and the next login retries.
 */

import { Prisma, type MemberRole } from "@prisma/client";
import prisma from "@/lib/prisma";
import { applyMembershipRoleEffects } from "@/lib/api/organizations/membership-transitions";
import { UNVERIFIED_ORG_SEAT_CAP } from "@/lib/enterprise/governance";
import { recordSystemEvent } from "@/lib/enterprise/system-events";
import { withSerializableRetry } from "@/lib/db/serializable-retry";

export type SsoJitInput = {
  userId: string;
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

  const role = org.ssoSettings?.defaultRoleForAutoJoin ?? DEFAULT_JIT_ROLE;

  try {
    const joined = await withSerializableRetry(() =>
      prisma.$transaction(
        async (tx) => {
          if (orgStatus === "PENDING_VERIFICATION") {
            const activeMembers = await tx.membership.count({
              where: { organizationId, status: "ACTIVE" },
            });
            if (activeMembers >= UNVERIFIED_ORG_SEAT_CAP) return false;
          }
          // Lazily creates the profile the role needs (LEARNER →
          // ConsulteeProfile, EXPERT → ConsultantProfile) in this same
          // transaction, so profile and membership commit together.
          const roleEffects = await applyMembershipRoleEffects(tx, {
            userId,
            role,
          });
          await tx.membership.create({
            data: {
              userId,
              organizationId,
              role,
              status: "ACTIVE",
              consulteeProfileId: roleEffects.consulteeProfileId,
              consultantProfileId: roleEffects.consultantProfileId,
              payoutRecipient: roleEffects.payoutRecipient,
            },
          });
          return true;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    );

    if (!joined) {
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
    // A concurrent login for the same user won the (userId, organizationId)
    // unique: the membership exists, which is the outcome we wanted.
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      return { kind: "already_member", organizationId };
    }
    throw err;
  }
}
