import prisma from "@/lib/prisma";
import { startDeadlineShare } from "@/lib/cron/run-deadline";
import { withCronLock } from "@/lib/cron/with-cron-lock";
import {
  flushNotificationsAfter,
  type StagedNotificationBundle,
} from "@/lib/novu/stage-then-attempt";
import { reportSentryError } from "@/lib/observability/report";
import {
  afterCollaborationEnded,
  endCollaboration,
  type EndedCollaboration,
} from "./ending";
import {
  INVITE_REMINDER_SCOPE,
  inviteReminderKey,
  stageCollaboratorNotifications,
} from "./notifications";
import { INVITE_REMINDER_DAYS_BEFORE, inviteLapsedBefore } from "./rules";

export interface ExpireStaleCollaboratorInvitesResult {
  expired: number;
  reminded: number;
  scanned: number;
  failed: number;
  /** The run stopped at its time budget with rows left for the next one. */
  hasMore: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** The ticker aborts this job at 15 s, so no row starts after half the shared start budget (8 s). */
const START_BUDGET_SHARE = 0.5;
/** Invitations inside the reminder window that one run reads to find those not yet reminded. */
const REMINDER_SCAN = 500;

/**
 * Ends invitations nobody answered within the invitation window as EXPIRED,
 * and reminds each invitee once shortly before theirs lapses. Every row has a
 * transaction of its own, so its change and notices commit together and a row
 * answered or edited in the meantime is left alone. No row starts past the
 * time budget, and whatever failed is reported once for the run.
 */
export async function expireStaleCollaboratorInvites(
  limit = 50,
): Promise<ExpireStaleCollaboratorInvitesResult> {
  const effectiveLimit = Math.min(Math.max(1, limit), 50);
  return withCronLock(
    "expire-stale-collaborator-invites",
    { failMode: "open" },
    async () => {
      const outOfTime = startDeadlineShare(START_BUDGET_SHARE);
      const cutoff = inviteLapsedBefore(new Date());
      const failures: { id: string; error: unknown }[] = [];
      let hasMore = false;

      const lapsed = await prisma.collaborator.findMany({
        where: { status: "PENDING", updatedAt: { lt: cutoff } },
        take: effectiveLimit,
        orderBy: { updatedAt: "asc" },
        select: { id: true },
      });
      const ended: EndedCollaboration[] = [];
      for (const { id } of lapsed) {
        if (outOfTime()) {
          hasMore = true;
          break;
        }
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

      const due = hasMore ? [] : await invitationsToRemind(cutoff);
      const reminders: StagedNotificationBundle[] = [];
      for (const { id, updatedAt } of due.slice(0, effectiveLimit)) {
        if (outOfTime()) {
          hasMore = true;
          break;
        }
        try {
          const notices = await prisma.$transaction(async (tx) => {
            const current = await tx.collaborator.findFirst({
              where: { id, status: "PENDING", updatedAt },
            });
            return current
              ? stageCollaboratorNotifications(tx, "EXPIRING_SOON", current)
              : null;
          });
          if (notices?.bells?.length || notices?.emails?.length) {
            reminders.push(notices);
          }
        } catch (error) {
          failures.push({ id, error });
        }
      }
      hasMore ||= due.length > effectiveLimit;

      const scanned = lapsed.length + due.length;
      if (failures.length > 0) {
        reportSentryError(failures[0].error, {
          subsystem: "collaborators",
          op: "expireStaleCollaboratorInvites",
          extra: {
            failed: failures.length,
            scanned,
            collaboratorIds: failures.map((f) => f.id),
          },
        });
      }
      await afterCollaborationEnded(ended, "collaborator.expired");
      if (reminders.length > 0) {
        await flushNotificationsAfter(
          {
            bells: reminders.flatMap((r) => r.bells ?? []),
            emails: reminders.flatMap((r) => r.emails ?? []),
          },
          "collaborator.expiringSoon",
        );
      }
      return {
        expired: ended.length,
        reminded: reminders.length,
        scanned,
        failed: failures.length,
        hasMore,
      };
    },
  );
}

/**
 * Pending invitations that lapse within the reminder window and have not been
 * reminded on their current terms, soonest to lapse first.
 */
async function invitationsToRemind(
  cutoff: Date,
): Promise<{ id: string; updatedAt: Date }[]> {
  const inWindow = await prisma.collaborator.findMany({
    where: {
      status: "PENDING",
      updatedAt: {
        gte: cutoff,
        lt: new Date(cutoff.getTime() + INVITE_REMINDER_DAYS_BEFORE * DAY_MS),
      },
    },
    take: REMINDER_SCAN,
    orderBy: { updatedAt: "asc" },
    select: { id: true, updatedAt: true },
  });
  if (inWindow.length === 0) return [];
  const claimed = await prisma.idempotencyRecord.findMany({
    where: {
      scope: INVITE_REMINDER_SCOPE,
      key: { in: inWindow.map(inviteReminderKey) },
    },
    select: { key: true },
  });
  const reminded = new Set(claimed.map((c) => c.key));
  return inWindow.filter((row) => !reminded.has(inviteReminderKey(row)));
}
