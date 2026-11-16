import prisma from "@/lib/prisma";
import { withCronLock } from "@/lib/cron/with-cron-lock";
import { reportSentryError } from "@/lib/observability/report";
import {
  afterCollaborationEnded,
  endCollaboration,
  type EndedCollaboration,
} from "./ending";
import { inviteLapsedBefore } from "./rules";

export interface ExpireStaleCollaboratorInvitesResult {
  expired: number;
  scanned: number;
  failed: number;
}

/**
 * Ends invitations nobody answered within the invitation window as EXPIRED,
 * one transaction each, so each expiry and its notices commit together and a
 * row answered or edited in the meantime is left alone.
 */
export async function expireStaleCollaboratorInvites(
  limit = 50,
): Promise<ExpireStaleCollaboratorInvitesResult> {
  const effectiveLimit = Math.min(Math.max(1, limit), 50);
  return withCronLock(
    "expire-stale-collaborator-invites",
    { failMode: "open" },
    async () => {
      const cutoff = inviteLapsedBefore(new Date());
      const candidates = await prisma.collaborator.findMany({
        where: { status: "PENDING", updatedAt: { lt: cutoff } },
        take: effectiveLimit,
        orderBy: { updatedAt: "asc" },
        select: { id: true },
      });

      const ended: EndedCollaboration[] = [];
      const failures: { id: string; error: unknown }[] = [];
      for (const { id } of candidates) {
        try {
          const one = await prisma.$transaction((tx) =>
            endCollaboration(tx, {
              collaboratorId: id,
              to: "EXPIRED",
              endedByUserId: null,
              where: { updatedAt: { lt: cutoff } },
            }),
          );
          if (one) ended.push(one);
        } catch (error) {
          failures.push({ id, error });
        }
      }
      if (failures.length > 0) {
        reportSentryError(failures[0].error, {
          subsystem: "collaborators",
          op: "expireStaleCollaboratorInvites",
          extra: {
            failed: failures.length,
            scanned: candidates.length,
            collaboratorIds: failures.map((f) => f.id),
          },
        });
      }
      await afterCollaborationEnded(ended, "collaborator.expired");
      return {
        expired: ended.length,
        scanned: candidates.length,
        failed: failures.length,
      };
    },
  );
}
