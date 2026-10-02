/**
 * Auth Token Cleanup - Core Logic
 *
 * Cleans up expired authentication tokens for security and DB hygiene.
 * Removes expired verification tokens, sessions, and password reset tokens.
 *
 * This catches cases where:
 * - Users abandon email verification flows
 * - Password reset links expire unused
 * - Sessions expire but are not cleaned up by BetterAuth
 *
 * This module exports the core cleanup function.
 * It is imported by:
 * - jobs/cleanup-auth-tokens.ts (GitHub Actions)
 * - app/api/cleanup/auth-tokens/route.ts (API endpoint)
 *
 * Schedule: Daily at midnight
 */

import prisma from "../../lib/prisma";
import { AUDIT_ACTIONS } from "../../lib/enterprise/audit-actions";
import { withCronLock } from "@/lib/cron/with-cron-lock";

export interface AuthTokenCleanupResult {
  success: boolean;
  verificationTokensDeleted: number;
  sessionsDeleted: number;
  passwordResetTokensCleared: number;
  /** Expired request-level idempotency keys (lib/api/idempotency.ts). */
  idempotencyRecordsDeleted: number;
  /** Stale PENDING invitations transitioned to EXPIRED (#1487). */
  staleInvitationsExpired: number;
  totalCleaned: number;
  errors: string[];
  timestamp: string;
}

export interface StaleInvitationsCleanupResult {
  success: boolean;
  expired: number;
  errors: string[];
  timestamp: string;
}

/**
 * Clean up all expired auth tokens and stale pending invitations (#1487)
 */
// #476 — locked at the core so every entry (GH Actions / HTTP) shares one
// mutual exclusion; fail-open: repeat-safe side effects, lock is belt-and-braces.
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
  const passwordResetTokensCleared = 0;

  const now = new Date();

  console.log("🧹 Starting auth token cleanup...");
  console.log(`   Current time: ${now.toISOString()}`);

  try {
    // 1. Delete expired verification entries (includes password reset tokens)
    console.log("\n📧 Cleaning up expired verification entries...");
    const verificationResult = await prisma.verification.deleteMany({
      where: {
        expiresAt: { lt: now },
      },
    });
    verificationTokensDeleted = verificationResult.count;
    console.log(
      `   Deleted ${verificationTokensDeleted} expired verification entries`,
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    errors.push(`Verification cleanup: ${errorMessage}`);
    console.error(`   Error: ${errorMessage}`);
  }

  try {
    // 2. Delete expired sessions
    console.log("\n🔐 Cleaning up expired sessions...");
    const sessionResult = await prisma.session.deleteMany({
      where: {
        expiresAt: { lt: now },
      },
    });
    sessionsDeleted = sessionResult.count;
    console.log(`   Deleted ${sessionsDeleted} expired sessions`);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    errors.push(`Session cleanup: ${errorMessage}`);
    console.error(`   Error: ${errorMessage}`);
  }

  try {
    // 3. Drop expired request-level idempotency keys. These are short-lived by
    // design (24h, longer than any client retry window) and the table would
    // otherwise grow without bound. An expired row is also reusable in-place by
    // withIdempotency, so this sweep is housekeeping, not correctness.
    console.log("\n🔑 Cleaning up expired idempotency keys...");
    const idempotencyResult = await prisma.idempotencyRecord.deleteMany({
      where: { expiresAt: { lt: now } },
    });
    idempotencyRecordsDeleted = idempotencyResult.count;
    console.log(
      `   Deleted ${idempotencyRecordsDeleted} expired idempotency keys`,
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    errors.push(`Idempotency cleanup: ${errorMessage}`);
    console.error(`   Error: ${errorMessage}`);
  }

  try {
    // 4. Expire stale organization invitations (#1487 — folded from the
    // retired standalone cleanup-stale-invitations script).
    console.log("\n📨 Expiring stale organization invitations...");
    if (typeof prisma.invitation?.findMany === "function") {
      const inviteResult = await cleanupStaleInvitationsUnlocked(now);
      staleInvitationsExpired = inviteResult.expired;
      for (const err of inviteResult.errors) {
        errors.push(`Stale invitation cleanup: ${err}`);
      }
    } else if (typeof prisma.invitation?.updateMany === "function") {
      const invitationResult = await prisma.invitation.updateMany({
        where: { status: "PENDING", expiresAt: { lt: now } },
        data: { status: "EXPIRED" },
      });
      staleInvitationsExpired = invitationResult.count;
    }
    console.log(
      `   Expired ${staleInvitationsExpired} stale organization invitations`,
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    errors.push(`Stale invitation cleanup: ${errorMessage}`);
    console.error(`   Error: ${errorMessage}`);
  }

  // Note: BetterAuth stores password reset tokens in the Verification table
  // (with identifier prefix "reset-password:"), so they are already cleaned up
  // in step 1 above when expired verification entries are deleted.

  const totalCleaned =
    verificationTokensDeleted +
    sessionsDeleted +
    passwordResetTokensCleared +
    idempotencyRecordsDeleted +
    staleInvitationsExpired;

  // Summary
  console.log("\n📊 Auth Token Cleanup Summary:");
  console.log(`   Verification tokens: ${verificationTokensDeleted}`);
  console.log(`   Sessions: ${sessionsDeleted}`);
  console.log(`   Password reset tokens: ${passwordResetTokensCleared}`);
  console.log(`   Idempotency keys: ${idempotencyRecordsDeleted}`);
  console.log(`   Stale invitations expired: ${staleInvitationsExpired}`);
  console.log(`   Total cleaned: ${totalCleaned}`);

  return {
    success: errors.length === 0,
    verificationTokensDeleted,
    sessionsDeleted,
    passwordResetTokensCleared,
    idempotencyRecordsDeleted,
    staleInvitationsExpired,
    totalCleaned,
    errors,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Stale invitation expiry helper (folded into cleanup-auth-tokens per #1487).
 * Transitions PENDING invitations with expiresAt < now to EXPIRED and emits
 * an OrgAuditLog(MEMBER / INVITE_EXPIRED) entry per row.
 */
export async function cleanupStaleInvitations(): Promise<StaleInvitationsCleanupResult> {
  return withCronLock("cleanup-stale-invitations", { failMode: "open" }, () =>
    cleanupStaleInvitationsUnlocked(),
  );
}

async function cleanupStaleInvitationsUnlocked(
  now: Date = new Date(),
): Promise<StaleInvitationsCleanupResult> {
  const errors: string[] = [];
  let expired = 0;

  try {
    const candidates = await prisma.invitation.findMany({
      where: {
        status: "PENDING",
        expiresAt: { lt: now },
      },
      select: {
        id: true,
        organizationId: true,
        email: true,
        role: true,
        expiresAt: true,
      },
    });

    if (candidates.length === 0) {
      return {
        success: true,
        expired: 0,
        errors: [],
        timestamp: now.toISOString(),
      };
    }

    for (const invite of candidates) {
      try {
        const didExpire = await prisma.$transaction(async (tx) => {
          const fresh = await tx.invitation.findUnique({
            where: { id: invite.id },
            select: { status: true },
          });
          if (!fresh || fresh.status !== "PENDING") return false;

          await tx.invitation.update({
            where: { id: invite.id },
            data: { status: "EXPIRED" },
          });

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
        const message = err instanceof Error ? err.message : String(err);
        errors.push(`invitation ${invite.id}: ${message}`);
      }
    }

    return {
      success: errors.length === 0,
      expired,
      errors,
      timestamp: now.toISOString(),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      expired,
      errors: [message],
      timestamp: now.toISOString(),
    };
  }
}

/**
 * Disconnect from database - call this when done
 */
export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}
