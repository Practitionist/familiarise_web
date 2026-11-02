import prisma from "@/lib/prisma";
import { z } from "zod";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";
import { withCronLock } from "@/lib/cron/with-cron-lock";
import { deleteBoundedPage } from "@/lib/cron/run-deadline";
import {
  SESSION_SNAPSHOT,
  recordSessionEnds,
  sessionAccessLogReady,
} from "@/lib/auth/session-access-log";
import { SESSION_EXPIRES_IN_SECONDS } from "@/lib/auth/session-lifetime";

export interface AuthTokenCleanupResult {
  success: boolean;
  /** Includes BetterAuth password-reset tokens, which live in `Verification`. */
  verificationTokensDeleted: number;
  /** Expired sessions, each stamped EXPIRED into the access log first. */
  sessionsDeleted: number;
  accessLogsDeleted: number;
  idempotencyRecordsDeleted: number;
  staleInvitationsExpired: number;
  totalCleaned: number;
  errors: string[];
  timestamp: string;
  hasMore: boolean;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const DAY_MS = 24 * 60 * 60 * 1000;
const ACCESS_LOG_RETENTION_MS = 180 * DAY_MS;
const cleanupLimit = z.number().int().min(1).max(500).default(100);
const START_BUDGET_MS = 16_000;

export interface AuthTokenCleanupOptions {
  limit?: number;
  startedAt?: number;
}

/** One bounded auth-hygiene slice; every mutation rechecks expiry. */
export async function cleanupAuthTokens(
  options: AuthTokenCleanupOptions = {},
): Promise<AuthTokenCleanupResult> {
  const startedAt = options.startedAt ?? Date.now();
  return withCronLock("cleanup-auth-tokens", { failMode: "open" }, () =>
    cleanupAuthTokensUnlocked(options.limit, startedAt),
  );
}

async function cleanupAuthTokensUnlocked(
  requestedLimit: number | undefined,
  startedAt: number,
): Promise<AuthTokenCleanupResult> {
  const limit = cleanupLimit.parse(requestedLimit);
  const outOfTime = () => Date.now() >= startedAt + START_BUDGET_MS;
  let hasMore = false;
  const errors: string[] = [];
  let verificationTokensDeleted = 0;
  let sessionsDeleted = 0;
  let accessLogsDeleted = 0;
  let idempotencyRecordsDeleted = 0;
  let staleInvitationsExpired = 0;
  const now = new Date();

  const where = { expiresAt: { lt: now } };
  const selection = {
    where,
    select: { id: true },
    orderBy: [{ expiresAt: "asc" as const }, { id: "asc" as const }],
    take: limit,
  };
  const prune = async (
    label: string,
    pick: () => Promise<{ id: string }[]>,
    remove: (ids: string[]) => Promise<{ count: number }>,
    remains: () => Promise<{ id: string } | null>,
  ): Promise<number> => {
    const page = await deleteBoundedPage({
      outOfTime,
      pick,
      remove,
      remains,
      onError: (error) => {
        errors.push(`${label} cleanup: ${messageOf(error)}`);
      },
    });
    hasMore ||= page.hasMore;
    return page.deleted;
  };
  verificationTokensDeleted = await prune(
    "Verification",
    () => prisma.verification.findMany(selection),
    (ids) =>
      prisma.verification.deleteMany({ where: { ...where, id: { in: ids } } }),
    () => prisma.verification.findFirst({ where, select: { id: true } }),
  );
  // Until the access-log table exists, expired sessions stay as the trail.
  if (await sessionAccessLogReady(prisma)) {
    const sessions = await pruneSessions(now, limit, outOfTime);
    const logs = await pruneAccessLogs(now, limit, outOfTime);
    sessionsDeleted = sessions.deleted;
    accessLogsDeleted = logs.deleted;
    hasMore ||= sessions.hasMore || logs.hasMore;
    errors.push(...sessions.errors, ...logs.errors);
  }
  // An expired idempotency row may be refreshed in place after selection.
  idempotencyRecordsDeleted = await prune(
    "Idempotency",
    () => prisma.idempotencyRecord.findMany(selection),
    (ids) =>
      prisma.idempotencyRecord.deleteMany({
        where: { ...where, id: { in: ids } },
      }),
    () => prisma.idempotencyRecord.findFirst({ where, select: { id: true } }),
  );

  const inviteResult = await expireStaleInvitations(now, limit, outOfTime);
  staleInvitationsExpired = inviteResult.expired;
  hasMore ||= inviteResult.hasMore;
  for (const err of inviteResult.errors) {
    errors.push(`Stale invitation cleanup: ${err}`);
  }

  const totalCleaned =
    verificationTokensDeleted +
    sessionsDeleted +
    accessLogsDeleted +
    idempotencyRecordsDeleted +
    staleInvitationsExpired;

  if (errors.length > 0) {
    console.error("cleanup-auth-tokens errors:", errors);
  }

  return {
    success: errors.length === 0,
    verificationTokensDeleted,
    sessionsDeleted,
    accessLogsDeleted,
    idempotencyRecordsDeleted,
    staleInvitationsExpired,
    totalCleaned,
    errors,
    timestamp: new Date().toISOString(),
    hasMore,
  };
}

type DrainResult = { deleted: number; hasMore: boolean; errors: string[] };

/** Runs `page` until a page comes back short, a page fails, or the budget is spent. */
async function drain(
  label: string,
  limit: number,
  outOfTime: () => boolean,
  page: () => Promise<{ picked: number; deleted: number }>,
): Promise<DrainResult> {
  let deleted = 0;
  for (;;) {
    if (outOfTime()) return { deleted, hasMore: true, errors: [] };
    try {
      const result = await page();
      deleted += result.deleted;
      if (result.picked < limit) return { deleted, hasMore: false, errors: [] };
    } catch (error) {
      return {
        deleted,
        hasMore: true,
        errors: [`${label} cleanup: ${messageOf(error)}`],
      };
    }
  }
}

/**
 * Expired sessions: delete, then stamp EXPIRED (ended at `expiresAt`) only the
 * rows the delete removed, in one transaction. A session refreshed after the
 * read fails the delete's expiry check and stays unstamped; a failed stamp
 * rolls the delete back for the next run.
 */
function pruneSessions(now: Date, limit: number, outOfTime: () => boolean) {
  const where = { expiresAt: { lt: now } };
  return drain("Session", limit, outOfTime, () =>
    prisma.$transaction(async (tx) => {
      const rows = await tx.session.findMany({
        where,
        select: SESSION_SNAPSHOT,
        orderBy: [{ expiresAt: "asc" }, { id: "asc" }],
        take: limit,
      });
      if (rows.length === 0) return { picked: 0, deleted: 0 };
      const ids = rows.map((row) => row.id);
      const { count } = await tx.session.deleteMany({
        where: { ...where, id: { in: ids } },
      });
      const kept =
        count === rows.length
          ? new Set<string>()
          : new Set(
              (
                await tx.session.findMany({
                  where: { id: { in: ids } },
                  select: { id: true },
                })
              ).map((row) => row.id),
            );
      const ended = rows.filter((row) => !kept.has(row.id));
      if (
        !(await recordSessionEnds(tx, ended, "EXPIRED", now, {
          sessionsLocked: true,
        }))
      ) {
        throw new Error("access-log stamp failed; expired sessions kept");
      }
      return { picked: rows.length, deleted: count };
    }),
  );
}

/**
 * CERT-In keeps an access-log row 180 days after its session ended. A row never
 * stamped (its end write failed) is aged from its start plus one session length.
 */
function pruneAccessLogs(now: Date, limit: number, outOfTime: () => boolean) {
  const cutoff = new Date(now.getTime() - ACCESS_LOG_RETENTION_MS);
  const where = {
    OR: [
      { endedAt: { lt: cutoff } },
      {
        endedAt: null,
        startedAt: {
          lt: new Date(cutoff.getTime() - SESSION_EXPIRES_IN_SECONDS * 1000),
        },
      },
    ],
  };
  return drain("SessionAccessLog", limit, outOfTime, async () => {
    const rows = await prisma.sessionAccessLog.findMany({
      where,
      select: { id: true },
      take: limit,
    });
    if (rows.length === 0) return { picked: 0, deleted: 0 };
    const { count } = await prisma.sessionAccessLog.deleteMany({
      where: { ...where, id: { in: rows.map((row) => row.id) } },
    });
    return { picked: rows.length, deleted: count };
  });
}

/** Expires lapsed PENDING invitations, writing one MEMBER/INVITE_EXPIRED audit row each. */
async function expireStaleInvitations(
  now: Date,
  limit: number,
  outOfTime: () => boolean,
): Promise<{ expired: number; errors: string[]; hasMore: boolean }> {
  const errors: string[] = [];
  let expired = 0;
  let hasMore = false;
  if (outOfTime()) return { expired, errors, hasMore: true };

  try {
    const candidates = await prisma.invitation.findMany({
      where: { status: "PENDING", expiresAt: { lt: now } },
      take: limit,
      orderBy: [{ expiresAt: "asc" }, { id: "asc" }],
      select: {
        id: true,
        organizationId: true,
        email: true,
        role: true,
        expiresAt: true,
      },
    });

    for (const invite of candidates) {
      if (outOfTime()) {
        hasMore = true;
        break;
      }
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
        hasMore = true;
        errors.push(`invitation ${invite.id}: ${messageOf(err)}`);
      }
    }
    if (
      outOfTime() ||
      (await prisma.invitation.findFirst({
        where: { status: "PENDING", expiresAt: { lt: now } },
        select: { id: true },
      }))
    )
      hasMore = true;
  } catch (err) {
    hasMore = true;
    errors.push(messageOf(err));
  }

  return { expired, errors, hasMore };
}
