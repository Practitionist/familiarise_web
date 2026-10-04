import prisma from "@/lib/prisma";
import {
  getStreamVideoClient,
  isStreamConfigured,
  withStreamCircuitBreaker,
} from "@/lib/stream-client";
import { STREAM_CALL_TYPE, toCallId } from "@/lib/stream/call-cid";
import { withCronLock } from "@/lib/cron/with-cron-lock";

export interface ReconciliationResult {
  processed: number;
  reconciled: number;
  streamNotFound: number;
  errors: number;
  success: boolean;
  details: string[];
}

/** Reconciles orphaned Meeting rows whose occurrence ended over 1 hour ago, ordered oldest-first. */
export async function reconcileOrphanedSessions(): Promise<ReconciliationResult> {
  return withCronLock("reconcile-orphaned-sessions", { failMode: "open" }, () =>
    reconcileOrphanedSessionsUnlocked(),
  );
}

interface OrphanedSessionRow {
  id: string;
  streamCallId: string;
  occurrence: {
    endsAt: Date | string;
  };
}

function isStreamCallNotFoundError(err: unknown): boolean {
  if (typeof err === "object" && err !== null) {
    const tagged = err as {
      status?: unknown;
      statusCode?: unknown;
      metadata?: { responseCode?: unknown };
    };
    const code =
      tagged.status ?? tagged.statusCode ?? tagged.metadata?.responseCode;
    if (typeof code === "number") {
      return code === 404;
    }
  }
  const message = err instanceof Error ? err.message : String(err);
  return /not[\s_-]*found|404|does not exist/i.test(message);
}

async function resolveOrphanedSessionEnd(
  session: OrphanedSessionRow,
  result: ReconciliationResult,
): Promise<{ endedAt: Date; endedReason: string } | null> {
  const fallbackEndedAt = new Date(session.occurrence.endsAt);
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
    const response = await withStreamCircuitBreaker(() => call.get());

    if (response.call.ended_at) {
      result.reconciled++;
      return {
        endedAt: new Date(response.call.ended_at),
        endedReason: "reconciled",
      };
    }

    const callSession = (
      response.call as {
        session?: { ended_at?: string | Date | null; participants?: unknown[] };
      }
    ).session;
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
    if (!isStreamCallNotFoundError(streamError)) {
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
): Promise<void> {
  result.processed++;

  try {
    const resolved = await resolveOrphanedSessionEnd(session, result);
    if (!resolved) return;
    const { endedAt, endedReason } = resolved;

    const closeMeetingAndPresence = async (
      db: Pick<typeof prisma, "meeting" | "meetingPresence">,
    ) => {
      const updated = await db.meeting.updateMany({
        where: { id: session.id, endedAt: null },
        data: { endedAt, endedReason },
      });

      if (updated.count !== 0) {
        await db.meetingPresence.updateMany({
          where: { meetingId: session.id, leftAt: null },
          data: { leftAt: endedAt },
        });
      }
    };

    if (typeof prisma.$transaction === "function") {
      await prisma.$transaction((tx) => closeMeetingAndPresence(tx));
    } else {
      await closeMeetingAndPresence(prisma);
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

export const BATCH_SIZE = 100;
export const MAX_BATCH_PAGES = 10;

async function reconcileOrphanedSessionsUnlocked(): Promise<ReconciliationResult> {
  const result: ReconciliationResult = {
    processed: 0,
    reconciled: 0,
    streamNotFound: 0,
    errors: 0,
    success: true,
    details: [],
  };

  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  let lastCursorId: string | null = null;

  for (let page = 0; page < MAX_BATCH_PAGES; page++) {
    const orphanedSessions: OrphanedSessionRow[] =
      await prisma.meeting.findMany({
        where: {
          endedAt: null,
          occurrence: {
            endsAt: { lt: oneHourAgo },
          },
        },
        include: {
          occurrence: true,
        },
        orderBy: [{ occurrence: { endsAt: "asc" } }, { id: "asc" }],
        take: BATCH_SIZE,
        ...(lastCursorId ? { cursor: { id: lastCursorId }, skip: 1 } : {}),
      });

    if (orphanedSessions.length === 0) {
      if (page === 0) {
        result.details.push("No orphaned sessions found");
      }
      break;
    }

    console.log(
      `[reconcile-orphaned-sessions] Page ${page + 1}: found ${orphanedSessions.length} orphaned sessions`,
    );

    await orphanedSessions.reduce<Promise<void>>(
      (chain, session) =>
        chain.then(() => reconcileSingleOrphanedSession(session, result)),
      Promise.resolve(),
    );

    if (orphanedSessions.length < BATCH_SIZE) {
      break;
    }

    lastCursorId = orphanedSessions[orphanedSessions.length - 1].id;
  }

  return result;
}
