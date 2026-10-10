import type { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import { withCronLock } from "@/lib/cron/with-cron-lock";
import { removeSubscriber } from "@/lib/novu/subscriber";
import { reportSentryMessage } from "@/lib/observability/report";

export const UNVERIFIED_ACCOUNT_TTL_DAYS = 7;
export const DEFAULT_PURGE_LIMIT = 200;

/**
 * A never-verified consumer created with a password more than 7 days ago
 * that nothing hangs off: no other sign-in method, profile, booking, payment,
 * invoice, referral credit or membership. Re-applied in the delete itself, so
 * a user who verifies mid-run is never removed.
 */
export function unverifiedUserPurgeWhere(now: Date): Prisma.UserWhereInput {
  const cutoff = new Date(
    now.getTime() - UNVERIFIED_ACCOUNT_TTL_DAYS * 24 * 60 * 60 * 1000,
  );
  return {
    emailVerified: false,
    role: "CONSULTEE",
    createdAt: { lt: cutoff },
    erasedAt: null,
    consultantProfileId: null,
    consulteeProfileId: null,
    staffProfileId: null,
    adminProfileId: null,
    orgWorkspaceProfileId: null,
    accounts: { every: { providerId: "credential" } },
    Payment: { none: {} },
    consumerInvoices: { none: {} },
    appointmentParticipations: { none: {} },
    referralCredits: { none: {} },
    memberships: { none: {} },
  };
}

export interface PurgeUnverifiedUsersResult {
  success: boolean;
  scanned: number;
  purged: number;
  failed: number;
}

/**
 * The `purge-unverified-users` registry job: frees addresses squatted by a
 * sign-up nobody verified. Failures are reported once per run.
 */
export async function purgeUnverifiedUsers(
  opts: { limit?: number; now?: Date } = {},
): Promise<PurgeUnverifiedUsersResult> {
  return withCronLock(
    "purge-unverified-users",
    { failMode: "open" },
    async () => {
      const where = unverifiedUserPurgeWhere(opts.now ?? new Date());
      const candidates = await prisma.user.findMany({
        where,
        select: { id: true },
        orderBy: { createdAt: "asc" },
        take: opts.limit ?? DEFAULT_PURGE_LIMIT,
      });

      let purged = 0;
      const failures: string[] = [];
      const subscriberFailures: string[] = [];
      for (const { id } of candidates) {
        let count = 0;
        try {
          ({ count } = await prisma.user.deleteMany({
            where: { ...where, id },
          }));
          purged += count;
        } catch {
          failures.push(id);
        }
        // Best effort: users synced before verification gated Novu still have one.
        if (count > 0) {
          await removeSubscriber(id).catch(() => subscriberFailures.push(id));
        }
      }

      if (failures.length > 0 || subscriberFailures.length > 0) {
        reportSentryMessage("UNVERIFIED_USER_PURGE_FAILURES", {
          subsystem: "auth",
          level: "warning",
          extra: {
            failed: failures.length,
            userIds: failures.slice(0, 20),
            subscriberDeleteFailed: subscriberFailures.length,
            subscriberUserIds: subscriberFailures.slice(0, 20),
          },
        });
      }
      return {
        success: failures.length === 0,
        scanned: candidates.length,
        purged,
        failed: failures.length,
      };
    },
  );
}
