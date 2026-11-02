import prisma from "@/lib/prisma";
import { z } from "zod";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";
import { withCronLock } from "@/lib/cron/with-cron-lock";
import { deleteBoundedPage } from "@/lib/cron/run-deadline";

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
  hasMore: boolean;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const SESSION_LOG_RETENTION_MS = 180 * 24 * 60 * 60 * 1000;
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
  // CERT-In access log: a lapsed row's IP and user agent stay 180 days. It never authenticates;
  // Better Auth's getSession deletes it if a browser still presents its cookie.
  const sessionWhere = {
    expiresAt: { lt: new Date(now.getTime() - SESSION_LOG_RETENTION_MS) },
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
  sessionsDeleted = await prune(
    "Session",
    () => prisma.session.findMany({ ...selection, where: sessionWhere }),
    (ids) =>
      prisma.session.deleteMany({
        where: { ...sessionWhere, id: { in: ids } },
      }),
    () =>
      prisma.session.findFirst({ where: sessionWhere, select: { id: true } }),
  );
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
    hasMore,
  };
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
