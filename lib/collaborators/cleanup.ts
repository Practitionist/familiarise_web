import prisma from "@/lib/prisma";
import { withCronLock } from "@/lib/cron/with-cron-lock";
import { stageCollaboratorNotifications } from "./notifications";
import {
  flushNotificationsAfter,
  type StagedNotificationBundle,
} from "@/lib/novu/stage-then-attempt";

const STALE_INVITE_MS = 14 * 24 * 60 * 60 * 1000;

export interface ExpireStaleCollaboratorInvitesResult {
  expired: number;
  scanned: number;
}

/** Expiry and both notification channels commit together for each stale invitation. */
export async function expireStaleCollaboratorInvites(
  limit = 50,
): Promise<ExpireStaleCollaboratorInvitesResult> {
  const effectiveLimit = Math.min(Math.max(1, limit), 50);
  return withCronLock(
    "expire-stale-collaborator-invites",
    { failMode: "open" },
    async () => {
      const now = new Date();
      const cutoff = new Date(now.getTime() - STALE_INVITE_MS);
      const candidates = await prisma.collaborator.findMany({
        where: { status: "PENDING", updatedAt: { lt: cutoff } },
        take: effectiveLimit,
        orderBy: { updatedAt: "asc" },
        select: { id: true },
      });
      let expired = 0;
      const bundles: StagedNotificationBundle[] = [];
      const failures: unknown[] = [];
      for (const candidate of candidates) {
        try {
          const bundle = await prisma.$transaction(async (tx) => {
            const moved = await tx.collaborator.updateMany({
              where: {
                id: candidate.id,
                status: "PENDING",
                updatedAt: { lt: cutoff },
              },
              data: { status: "DECLINED", respondedAt: now },
            });
            if (moved.count === 0) return null;
            const collaborator = await tx.collaborator.findUniqueOrThrow({
              where: { id: candidate.id },
            });
            return stageCollaboratorNotifications(tx, "EXPIRED", collaborator);
          });
          if (bundle) {
            expired += 1;
            bundles.push(bundle);
          }
        } catch (error) {
          failures.push(error);
        }
      }
      await flushNotificationsAfter(
        {
          bells: bundles.flatMap((bundle) => bundle.bells ?? []),
          emails: bundles.flatMap((bundle) => bundle.emails ?? []),
        },
        "collaborator.expired",
      );
      if (failures.length > 0)
        throw new AggregateError(
          failures,
          `Failed to stage ${failures.length} expired collaborator invitation(s)`,
        );
      return { expired, scanned: candidates.length };
    },
  );
}
