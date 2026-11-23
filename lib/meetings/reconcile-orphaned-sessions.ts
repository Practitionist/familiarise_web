import prisma from "@/lib/prisma";
import type { PrismaLike } from "@/lib/prisma";
import {
  getStreamVideoClient,
  isStreamConfigured,
  isExpectedStreamError,
  withStreamCircuitBreaker,
} from "@/lib/stream-client";
import { STREAM_CALL_TYPE, toCallId } from "@/lib/stream/call-cid";
import { withCronLock, readJobCheckpoint } from "@/lib/cron/with-cron-lock";
import {
  createRunFailureReporter,
  type RunFailureReporter,
} from "@/lib/observability/run-failures";
import { resolveRoomEndsAt } from "@/lib/meetings/duration-cap";
import type { MeetingEndReason } from "@/lib/meetings/end-reasons";

export interface ReconciliationResult {
  processed: number;
  reconciled: number;
  streamNotFound: number;
  errors: number;
  success: boolean;
  details: string[];
  checkpoint: string | null;
  hasMore: boolean;
}

/** Reconcile a bounded rotating slice of rooms whose booked end passed over an hour ago. */
export async function reconcileOrphanedSessions(
  options: { limit?: number } = {},
): Promise<ReconciliationResult> {
  return withCronLock(
    "reconcile-orphaned-sessions",
    { failMode: "closed" },
    async () => {
      const failures = createRunFailureReporter("stream");
      try {
        return await reconcileOrphanedSessionsUnlocked(
          options.limit ?? BATCH_SIZE,
          failures,
        );
      } finally {
        failures.flush();
      }
    },
  );
}

interface OrphanedSessionRow {
  id: string;
  streamCallId: string;
  extendedSeconds: number;
  lastStreamSessionId: string | null;
  lastJoinedAt: Date | null;
  occurrence: {
    endsAt: Date | string;
  };
}

const roomEndOf = (session: OrphanedSessionRow) =>
  resolveRoomEndsAt(session.occurrence.endsAt, session.extendedSeconds);

async function resolveOrphanedSessionEnd(
  session: OrphanedSessionRow,
  result: ReconciliationResult,
  failures: RunFailureReporter,
): Promise<{
  endedAt: Date;
  endedReason: MeetingEndReason;
  /** The call's latest session as Stream names it, recorded with the end. */
  sessionId?: string;
} | null> {
  const fallbackEndedAt = roomEndOf(session);
  if (!isStreamConfigured()) {
    result.streamNotFound++;
    return { endedAt: fallbackEndedAt, endedReason: "stream_not_configured" };
  }

  try {
    const client = getStreamVideoClient();
    const call = client.video.call(
      STREAM_CALL_TYPE,
      toCallId(session.streamCallId),
    );
    const response = await withStreamCircuitBreaker(
      () => call.get(),
      undefined,
      failures,
    );

    const callSession = response.call.session;
    const sessionId = callSession?.id || undefined;
    if (response.call.ended_at) {
      result.reconciled++;
      return {
        endedAt: new Date(response.call.ended_at),
        endedReason: "reconciled",
        sessionId,
      };
    }

    if (callSession?.ended_at) {
      result.reconciled++;
      return {
        endedAt: new Date(callSession.ended_at),
        endedReason: "reconciled",
        sessionId,
      };
    }
    if ((callSession?.participants?.length ?? 0) > 0) {
      result.details.push(
        `Session ${session.id} (call: ${session.streamCallId}): skipped_active_session`,
      );
      return null;
    }

    result.reconciled++;
    return {
      endedAt: fallbackEndedAt,
      endedReason: "reconciled_no_end",
      sessionId,
    };
  } catch (streamError) {
    if (!isExpectedStreamError(streamError)) {
      throw streamError;
    }
    result.streamNotFound++;
    console.warn(
      `[reconcile-orphaned-sessions] Stream call not found for ${session.streamCallId}:`,
      streamError instanceof Error
        ? streamError.message
        : JSON.stringify(streamError),
    );
    return { endedAt: fallbackEndedAt, endedReason: "stream_not_found" };
  }
}

async function reconcileSingleOrphanedSession(
  session: OrphanedSessionRow,
  result: ReconciliationResult,
  oneHourAgo: Date,
  failures: RunFailureReporter,
): Promise<void> {
  // The query filters on the booked end; an extended room is not orphaned until its room end passes.
  if (roomEndOf(session) >= oneHourAgo) return;
  result.processed++;

  try {
    const resolved = await resolveOrphanedSessionEnd(session, result, failures);
    if (!resolved) return;
    const { endedAt, endedReason, sessionId } = resolved;

    // The call id it asked Stream about: a room reopened on a new call since is not this one.
    const unended = {
      id: session.id,
      streamCallId: session.streamCallId,
      endedAt: null,
    };
    // Stream's session is written only while the room holds the session and join read before the lookup.
    const withSession = sessionId
      ? await prisma.meeting.updateMany({
          where: {
            ...unended,
            lastStreamSessionId: session.lastStreamSessionId,
            lastJoinedAt: session.lastJoinedAt,
          },
          data: { endedAt, endedReason, lastStreamSessionId: sessionId },
        })
      : { count: 0 };
    if (withSession.count === 0) {
      await prisma.meeting.updateMany({
        where: unended,
        data: { endedAt, endedReason },
      });
    }

    result.details.push(
      `Session ${session.id} (call: ${session.streamCallId}): ${endedReason}`,
    );
  } catch (error) {
    result.errors++;
    result.success = false;
    const msg = error instanceof Error ? error.message : String(error);
    result.details.push(`Session ${session.id} FAILED: ${msg}`);
    console.error(
      `[reconcile-orphaned-sessions] Failed to reconcile session ${session.id}:`,
      msg,
    );
  }
}

// Shared by the run's slice read and the ticker's idle probe.
function overdueOpenMeetingWhere(oneHourAgo: Date) {
  return { endedAt: null, occurrence: { endsAt: { lt: oneHourAgo } } };
}

export async function hasOrphanedSessionWork(
  db: PrismaLike,
  now: Date,
  outOfTime: () => boolean,
): Promise<boolean> {
  if (outOfTime()) return true;
  const row = await db.meeting.findFirst({
    where: overdueOpenMeetingWhere(new Date(now.getTime() - 60 * 60 * 1000)),
    select: { id: true },
  });
  return row !== null;
}

export const BATCH_SIZE = 5;
// Reserve the video client's 15-second request timeout and transactional close under the HTTP ceiling.
const START_BUDGET_MS = 6_000;

async function reconcileOrphanedSessionsUnlocked(
  limit: number,
  failures: RunFailureReporter,
): Promise<ReconciliationResult> {
  const stopStartingAt = Date.now() + START_BUDGET_MS;
  const result: ReconciliationResult = {
    processed: 0,
    reconciled: 0,
    streamNotFound: 0,
    errors: 0,
    success: true,
    details: [],
    checkpoint: await readJobCheckpoint("reconcile-orphaned-sessions"),
    hasMore: false,
  };
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const take = Math.min(Math.max(Math.trunc(limit), 1), BATCH_SIZE);
  const load = (after: string | null) =>
    prisma.meeting.findMany({
      where: {
        ...overdueOpenMeetingWhere(oneHourAgo),
        ...(after ? { id: { gt: after } } : {}),
      },
      select: {
        id: true,
        streamCallId: true,
        extendedSeconds: true,
        lastStreamSessionId: true,
        lastJoinedAt: true,
        occurrence: { select: { endsAt: true } },
      },
      orderBy: { id: "asc" },
      take,
    });
  let rows = await load(result.checkpoint);
  if (rows.length === 0 && result.checkpoint) {
    result.checkpoint = null;
    rows = await load(null);
  }
  result.hasMore = rows.length === take;
  let examined = 0;
  for (const session of rows) {
    if (Date.now() >= stopStartingAt) {
      result.hasMore = true;
      break;
    }
    result.checkpoint = session.id;
    examined++;
    await reconcileSingleOrphanedSession(session, result, oneHourAgo, failures);
  }
  if (examined === rows.length && rows.length < take) result.checkpoint = null;
  return result;
}
