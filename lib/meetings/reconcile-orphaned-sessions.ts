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
import { closeSegmentPresences } from "@/lib/meetings/segment-presence";

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
): Promise<{ endedAt: Date; endedReason: MeetingEndReason } | null> {
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

    if (response.call.ended_at) {
      result.reconciled++;
      return {
        endedAt: new Date(response.call.ended_at),
        endedReason: "reconciled",
      };
    }

    const callSession = response.call.session;
    if (callSession?.ended_at) {
      result.reconciled++;
      return {
        endedAt: new Date(callSession.ended_at),
        endedReason: "reconciled",
      };
    }
    if ((callSession?.participants?.length ?? 0) > 0) {
      result.details.push(
        `Session ${session.id} (call: ${session.streamCallId}): skipped_active_session`,
      );
      return null;
    }

    result.reconciled++;
    return { endedAt: fallbackEndedAt, endedReason: "reconciled_no_end" };
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
    const { endedAt, endedReason } = resolved;

    const closeMeetingAndPresence = async (
      db: Pick<typeof prisma, "meeting" | "meetingPresence">,
    ) => {
      const updated = await db.meeting.updateMany({
        where: {
          id: session.id,
          streamCallId: session.streamCallId,
          endedAt: null,
        },
        data: { endedAt, endedReason },
      });

      if (updated.count !== 0) {
        await closeSegmentPresences(db, {
          meetingId: session.id,
          streamCallId: session.streamCallId,
          endedAt,
        });
      }
    };

    await prisma.$transaction((tx) => closeMeetingAndPresence(tx));

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
