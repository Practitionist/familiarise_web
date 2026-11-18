import prisma from "@/lib/prisma";
import { startDeadlineShare } from "@/lib/cron/run-deadline";
import { withCronLock } from "@/lib/cron/with-cron-lock";
import {
  flushNotificationsAfter,
  type StagedNotificationBundle,
} from "@/lib/novu/stage-then-attempt";
import {
  createRunFailureReporter,
  type RunFailureReporter,
} from "@/lib/observability/run-failures";
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
/** The one op every failed row of a run is reported under. */
const SWEEP_OP = "expireStaleCollaboratorInvites";
/** Invitations inside the reminder window that one read returns. */
const REMINDER_PAGE = 200;

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
      const failures = createRunFailureReporter("collaborators");
      try {
        return await runExpirySweep(effectiveLimit, failures);
      } finally {
        failures.flush();
      }
    },
  );
}

/** One run of the sweep; the caller flushes `failures` once when it ends. */
async function runExpirySweep(
  effectiveLimit: number,
  failures: RunFailureReporter,
): Promise<ExpireStaleCollaboratorInvitesResult> {
  const outOfTime = startDeadlineShare(START_BUDGET_SHARE);
  const cutoff = inviteLapsedBefore(new Date());
  let failed = 0;
  const fail = (id: string, error: unknown) => {
    failed += 1;
    failures.add(SWEEP_OP, error, { collaboratorId: id });
  };
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
      fail(id, error);
    }
  }

  const scan = hasMore
    ? { due: [], hasMore: true }
    : await invitationsToRemind(cutoff, effectiveLimit, outOfTime);
  const { due } = scan;
  hasMore ||= scan.hasMore;
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
      fail(id, error);
    }
  }
  hasMore ||= due.length > effectiveLimit;

  const scanned = lapsed.length + due.length;
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
    failed,
    hasMore,
  };
}

/**
 * Pending invitations that lapse within the reminder window and have not been
 * reminded on their current terms, soonest to lapse first. Reads the window a
 * page at a time by `(updatedAt, id)` until it holds `wanted` of them or the
 * window or the time budget ends.
 */
async function invitationsToRemind(
  cutoff: Date,
  wanted: number,
  outOfTime: () => boolean,
): Promise<{ due: { id: string; updatedAt: Date }[]; hasMore: boolean }> {
  const windowEnd = new Date(
    cutoff.getTime() + INVITE_REMINDER_DAYS_BEFORE * DAY_MS,
  );
  const due: { id: string; updatedAt: Date }[] = [];
  let after: { id: string; updatedAt: Date } | undefined;
  for (;;) {
    if (outOfTime()) return { due, hasMore: true };
    const page = await prisma.collaborator.findMany({
      where: {
        status: "PENDING",
        updatedAt: { gte: cutoff, lt: windowEnd },
        ...(after && {
          OR: [
            { updatedAt: { gt: after.updatedAt } },
            { updatedAt: after.updatedAt, id: { gt: after.id } },
          ],
        }),
      },
      take: REMINDER_PAGE,
      orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
      select: { id: true, updatedAt: true },
    });
    if (page.length > 0) {
      const claimed = await prisma.idempotencyRecord.findMany({
        where: {
          scope: INVITE_REMINDER_SCOPE,
          key: { in: page.map(inviteReminderKey) },
        },
        select: { key: true },
      });
      const reminded = new Set(claimed.map((c) => c.key));
      due.push(...page.filter((row) => !reminded.has(inviteReminderKey(row))));
    }
    if (page.length < REMINDER_PAGE) return { due, hasMore: false };
    if (due.length >= wanted) return { due, hasMore: true };
    after = page[page.length - 1];
  }
}
