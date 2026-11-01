import { randomUUID } from "node:crypto";
import { Prisma, type SessionEndReason } from "@prisma/client";
import { z } from "zod";
import prisma, { type PrismaLike } from "@/lib/prisma";
import { reportSentryError } from "@/lib/observability/report";
import { CLIENT_IP_HEADER } from "@/lib/request-ip";

/** The Session columns the CERT-In access log copies. */
export const SESSION_SNAPSHOT = {
  id: true,
  userId: true,
  ipAddress: true,
  userAgent: true,
  createdAt: true,
  expiresAt: true,
} as const satisfies Prisma.SessionSelect;

export type SessionSnapshot = Prisma.SessionGetPayload<{
  select: typeof SESSION_SNAPSHOT;
}>;

type HookSession = {
  id: string;
  userId: string;
  createdAt: Date;
  expiresAt: Date;
  ipAddress?: string | null;
  userAgent?: string | null;
};

/** The snapshot of a row Better Auth hands its database hooks. */
export function sessionSnapshot(session: HookSession): SessionSnapshot {
  return {
    id: session.id,
    userId: session.userId,
    ipAddress: session.ipAddress ?? null,
    userAgent: session.userAgent ?? null,
    createdAt: new Date(session.createdAt),
    expiresAt: new Date(session.expiresAt),
  };
}

let tableReady = false;
let reported = false;

/**
 * True once `session_access_logs` exists. The probe cannot fail on a missing
 * table, so it is safe inside a caller's transaction; a positive answer is cached.
 */
export async function sessionAccessLogReady(db: PrismaLike): Promise<boolean> {
  if (tableReady) return true;
  try {
    const [row] = await db.$queryRaw<{ ready: boolean }[]>`
      SELECT to_regclass('session_access_logs') IS NOT NULL AS ready`;
    tableReady = row?.ready === true;
  } catch {
    return false;
  }
  return tableReady;
}

/** Access logging never fails the auth action it records; Sentry hears once per process. */
async function guarded(op: string, write: () => Promise<unknown>) {
  try {
    await write();
    return true;
  } catch (error) {
    console.error(`[session-access-log] ${op} failed`, error);
    if (!reported) {
      reported = true;
      reportSentryError(error, {
        subsystem: "auth",
        op: `sessionAccessLog.${op}`,
      });
    }
    return false;
  }
}

/** Better Auth's endpoint path decides why a hook-deleted row ended. */
export function endReasonForPath(path: string | undefined): SessionEndReason {
  if (!path) return "UNKNOWN";
  if (path === "/sign-out") return "SIGN_OUT";
  if (path === "/get-session") return "EXPIRED_COOKIE";
  return "REVOKED";
}

const clientIp = z.string().trim().ip();

/**
 * One row per new session, written by the `session.create.after` hook. CERT-In
 * needs the source IP, so the full stamped address wins over `Session.ipAddress`,
 * which Better Auth masks to the /64 for IPv6.
 */
export async function recordSessionStart(
  session: SessionSnapshot,
  headers?: { get(name: string): string | null } | null,
) {
  if (!(await sessionAccessLogReady(prisma))) return;
  const stamped = clientIp.safeParse(headers?.get(CLIENT_IP_HEADER));
  await guarded("start", () =>
    prisma.sessionAccessLog.createMany({
      data: [
        {
          sessionId: session.id,
          userId: session.userId,
          ipAddress: stamped.success ? stamped.data : session.ipAddress,
          userAgent: session.userAgent,
          startedAt: session.createdAt,
        },
      ],
      skipDuplicates: true,
    }),
  );
}

/** A session row as the log stores it; erasure stamps without the user link. */
type LoggedSession = Omit<SessionSnapshot, "userId"> & {
  userId: string | null;
};

/**
 * Stamps the end of each session in one statement, creating the row if its
 * start was never logged. A row already past `expiresAt` ended then, as EXPIRED
 * unless Better Auth removed it on cookie presentation. The first stamp wins.
 * Returns false only when the write failed.
 */
export async function recordSessionEnds(
  db: PrismaLike,
  sessions: readonly LoggedSession[],
  reason: SessionEndReason,
  now: Date = new Date(),
): Promise<boolean> {
  if (sessions.length === 0) return true;
  if (!(await sessionAccessLogReady(db))) return false;
  const rows = sessions.map((s) => {
    const expired = s.expiresAt <= now;
    const endReason: SessionEndReason =
      expired && reason !== "EXPIRED_COOKIE" ? "EXPIRED" : reason;
    return Prisma.sql`(${randomUUID()}, ${s.id}, ${s.userId}, ${s.ipAddress},
      ${s.userAgent}, ${s.createdAt}, ${expired ? s.expiresAt : now},
      ${endReason}::"SessionEndReason")`;
  });
  return guarded(
    "end",
    () =>
      db.$executeRaw`
      INSERT INTO session_access_logs
        ("id", "sessionId", "userId", "ipAddress", "userAgent", "startedAt", "endedAt", "endReason")
      VALUES ${Prisma.join(rows)}
      ON CONFLICT ("sessionId") DO UPDATE
        SET "endedAt" = EXCLUDED."endedAt", "endReason" = EXCLUDED."endReason"
        WHERE session_access_logs."endedAt" IS NULL`,
  );
}

/** Sessions a write deleted, waiting for `stampSessionEnds` once it is durable. */
export interface EndedSessions {
  sessions: SessionSnapshot[];
  reason: SessionEndReason;
  endedAt: Date;
}

/**
 * Deletes the sessions matching `where` and returns them for the access log
 * without touching it, so a transaction caller stamps only after it commits.
 * The delete keeps the caller's predicate, so a row created after the read is still revoked.
 */
export async function endSessions(
  db: PrismaLike,
  where: Prisma.SessionWhereInput,
  reason: SessionEndReason,
): Promise<{ count: number; ended: EndedSessions }> {
  const endedAt = new Date();
  const sessions = (await sessionAccessLogReady(db))
    ? await db.session.findMany({ where, select: SESSION_SNAPSHOT })
    : [];
  const { count } = await db.session.deleteMany({ where });
  return { count, ended: { sessions, reason, endedAt } };
}

/**
 * Stamps ended sessions on the global client, after the deleting write has
 * committed; never throws. `forgetUser` drops the link for an erased account.
 * Returns how many went unstamped; the prune ages those rows from their start.
 */
export async function stampSessionEnds(
  ended: readonly EndedSessions[],
  { forgetUser = false }: { forgetUser?: boolean } = {},
): Promise<number> {
  let unstamped = 0;
  for (const batch of ended) {
    const sessions = forgetUser
      ? batch.sessions.map((s) => ({ ...s, userId: null }))
      : batch.sessions;
    if (
      !(await recordSessionEnds(prisma, sessions, batch.reason, batch.endedAt))
    ) {
      unstamped += sessions.length;
    }
  }
  return unstamped;
}

/**
 * Erasure keeps the IP, user agent and times until the 180-day prune (a legal
 * obligation under DPDP s.17 and the CERT-In Directions) and drops the user link.
 */
export async function detachSessionAccessLogs(db: PrismaLike, userId: string) {
  if (!(await sessionAccessLogReady(db))) return;
  await db.sessionAccessLog.updateMany({
    where: { userId },
    data: { userId: null },
  });
}

/** The user's access-log rows for the DPDP self-serve export. */
export async function readSessionAccessLog(userId: string) {
  if (!(await sessionAccessLogReady(prisma))) return [];
  return prisma.sessionAccessLog.findMany({
    where: { userId },
    orderBy: { startedAt: "desc" },
    take: 500,
    select: {
      startedAt: true,
      endedAt: true,
      endReason: true,
      ipAddress: true,
      userAgent: true,
    },
  });
}
