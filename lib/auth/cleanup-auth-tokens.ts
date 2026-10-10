import prisma from "@/lib/prisma";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";
import { withCronLock } from "@/lib/cron/with-cron-lock";

export interface AuthTokenCleanupResult {
  success: boolean;
  /** Includes BetterAuth password-reset tokens, which live in `Verification`. */
  verificationTokensDeleted: number;
  sessionsDeleted: number;
  idempotencyRecordsDeleted: number;
  staleInvitationsExpired: number;
  totalCleaned: number;
  errors: string[];
  timestamp: string;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Daily auth hygiene sweep, run via `/api/cleanup/auth-tokens`; every step is repeat-safe. */
export async function cleanupAuthTokens(): Promise<AuthTokenCleanupResult> {
  return withCronLock("cleanup-auth-tokens", { failMode: "open" }, () =>
    cleanupAuthTokensUnlocked(),
  );
}

async function cleanupAuthTokensUnlocked(): Promise<AuthTokenCleanupResult> {
  const errors: string[] = [];
  let verificationTokensDeleted = 0;
  let sessionsDeleted = 0;
  let idempotencyRecordsDeleted = 0;
  let staleInvitationsExpired = 0;
  const now = new Date();

  try {
    const res = await prisma.verification.deleteMany({
      where: { expiresAt: { lt: now } },
    });
    verificationTokensDeleted = res.count;
  } catch (error) {
    errors.push(`Verification cleanup: ${messageOf(error)}`);
  }

  try {
    const res = await prisma.session.deleteMany({
      where: { expiresAt: { lt: now } },
    });
    sessionsDeleted = res.count;
  } catch (error) {
    errors.push(`Session cleanup: ${messageOf(error)}`);
  }

  try {
    // Housekeeping only: withIdempotency already reuses an expired row in place.
    const res = await prisma.idempotencyRecord.deleteMany({
      where: { expiresAt: { lt: now } },
    });
    idempotencyRecordsDeleted = res.count;
  } catch (error) {
    errors.push(`Idempotency cleanup: ${messageOf(error)}`);
  }

  const inviteResult = await expireStaleInvitations(now);
  staleInvitationsExpired = inviteResult.expired;
  for (const err of inviteResult.errors) {
    errors.push(`Stale invitation cleanup: ${err}`);
  }

  const totalCleaned =
    verificationTokensDeleted +
    sessionsDeleted +
    idempotencyRecordsDeleted +
    staleInvitationsExpired;

  if (errors.length > 0) {
    console.error("cleanup-auth-tokens errors:", errors);
  }

  return {
    success: errors.length === 0,
    verificationTokensDeleted,
    sessionsDeleted,
    idempotencyRecordsDeleted,
    staleInvitationsExpired,
    totalCleaned,
    errors,
    timestamp: new Date().toISOString(),
  };
}

/** Expires lapsed PENDING invitations, writing one MEMBER/INVITE_EXPIRED audit row each. */
async function expireStaleInvitations(
  now: Date,
): Promise<{ expired: number; errors: string[] }> {
  const errors: string[] = [];
  let expired = 0;

  try {
    const candidates = await prisma.invitation.findMany({
      where: { status: "PENDING", expiresAt: { lt: now } },
      select: {
        id: true,
        organizationId: true,
        email: true,
        role: true,
        expiresAt: true,
      },
    });

    for (const invite of candidates) {
      try {
        const didExpire = await prisma.$transaction(async (tx) => {
          const { count } = await tx.invitation.updateMany({
            where: { id: invite.id, status: "PENDING", expiresAt: { lt: now } },
            data: { status: "EXPIRED" },
          });
          if (count === 0) return false;

          await tx.orgAuditLog.create({
            data: {
              organizationId: invite.organizationId,
              actorMembershipId: null,
              category: "MEMBER",
              action: AUDIT_ACTIONS.MEMBER.INVITE_EXPIRED,
              description: `Invitation for ${invite.email} auto-expired after its window lapsed`,
              details: {
                invitationId: invite.id,
                email: invite.email,
                role: invite.role,
                expiresAt: invite.expiresAt.toISOString(),
              },
            },
          });
          return true;
        });
        if (didExpire) expired += 1;
      } catch (err) {
        errors.push(`invitation ${invite.id}: ${messageOf(err)}`);
      }
    }
  } catch (err) {
    errors.push(messageOf(err));
  }

  return { expired, errors };
}
