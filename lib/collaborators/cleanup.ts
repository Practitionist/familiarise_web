import prisma from "@/lib/prisma";
import { withCronLock } from "@/lib/cron/with-cron-lock";
import {
  flushNotificationsAfter,
  type StagedNotificationBundle,
} from "@/lib/novu/stage-then-attempt";
import { stageCollaboratorNotifications } from "./notifications";

const STALE_INVITE_MS = 14 * 24 * 60 * 60 * 1000;

export interface ExpireStaleCollaboratorInvitesResult {
  expired: number;
  scanned: number;
}

/**
 * Transitions PENDING collaborator invitations older than 14 days to DECLINED
 * via conditional CAS update; each expiry stages its notices in the same transaction.
 */
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
      const staged: StagedNotificationBundle[] = [];
      for (const { id } of candidates) {
        const notices = await prisma.$transaction(async (tx) => {
          const updated = await tx.collaborator.updateMany({
            where: { id, status: "PENDING", updatedAt: { lt: cutoff } },
            data: { status: "DECLINED", respondedAt: now },
          });
          if (updated.count === 0) return null;
          const row = await tx.collaborator.findUniqueOrThrow({
            where: { id },
          });
          return stageCollaboratorNotifications(tx, "EXPIRED", row);
        });
        if (!notices) continue;
        expired += 1;
        staged.push(notices);
      }

      await flushNotificationsAfter(
        {
          bells: staged.flatMap((n) => n.bells ?? []),
          emails: staged.flatMap((n) => n.emails ?? []),
        },
        "collaborator.expired",
      );
      return { expired, scanned: candidates.length };
    },
  );
}
