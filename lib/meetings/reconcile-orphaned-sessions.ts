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

  const orphanedSessions = await prisma.meeting.findMany({
    where: {
      endedAt: null,
      occurrence: {
        endsAt: { lt: oneHourAgo },
      },
    },
    include: {
      occurrence: true,
    },
    orderBy: {
      occurrence: {
        endsAt: "asc",
      },
    },
    take: 100,
  });

  if (orphanedSessions.length === 0) {
    result.details.push("No orphaned sessions found");
    return result;
  }

  console.log(
    `[reconcile-orphaned-sessions] Found ${orphanedSessions.length} orphaned sessions`,
  );

  for (const session of orphanedSessions) {
    result.processed++;

    try {
      let endedAt: Date;
      let endedReason: string;

      if (isStreamConfigured()) {
        try {
          const client = getStreamVideoClient();
          const call = client.video.call(
            STREAM_CALL_TYPE,
            toCallId(session.streamCallId),
          );
          const response = await withStreamCircuitBreaker(() => call.get());

          if (response.call.ended_at) {
            endedAt = new Date(response.call.ended_at);
            endedReason = "reconciled";
            result.reconciled++;
          } else {
            endedAt = new Date(session.occurrence.endsAt);
            endedReason = "reconciled_no_end";
            result.reconciled++;
          }
        } catch (streamError) {
          endedAt = new Date(session.occurrence.endsAt);
          endedReason = "stream_not_found";
          result.streamNotFound++;

          console.warn(
            `[reconcile-orphaned-sessions] Stream lookup failed for ${session.streamCallId}:`,
            streamError instanceof Error
              ? streamError.message
              : JSON.stringify(streamError),
          );
        }
      } else {
        endedAt = new Date(session.occurrence.endsAt);
        endedReason = "stream_not_configured";
        result.streamNotFound++;
      }

      const updated = await prisma.meeting.updateMany({
        where: { id: session.id, endedAt: null },
        data: { endedAt, endedReason },
      });

      if (updated?.count !== 0 && prisma.meetingPresence?.updateMany) {
        await prisma.meetingPresence.updateMany({
          where: { meetingId: session.id, leftAt: null },
          data: { leftAt: endedAt },
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

  return result;
}
