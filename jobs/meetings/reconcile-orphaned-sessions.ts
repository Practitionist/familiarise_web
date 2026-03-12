/**
 * Orphaned Meeting Session Reconciliation Job
 *
 * Finds MeetingSession records where endedAt IS NULL and the linked
 * slot's endsAt is >1 hour ago. For each, queries Stream API to check
 * actual call status and reconciles accordingly.
 *
 * Runs every 30 minutes via cleanup API route.
 */

import prisma from "../../lib/prisma";
import {
  getStreamVideoClient,
  isStreamConfigured,
} from "../../lib/stream-client";
import { abortIfMaintenance } from "../../lib/maintenance-cron";

export interface ReconciliationResult {
  processed: number;
  reconciled: number;
  streamNotFound: number;
  errors: number;
  success: boolean;
  details: string[];
}

export async function reconcileOrphanedSessions(): Promise<ReconciliationResult> {
  const result: ReconciliationResult = {
    processed: 0,
    reconciled: 0,
    streamNotFound: 0,
    errors: 0,
    success: true,
    details: [],
  };

  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

  // Find orphaned sessions: endedAt is null and slot ended >1 hour ago
  const orphanedSessions = await prisma.meetingSession.findMany({
    where: {
      endedAt: null,
      slotOfAppointment: {
        endsAt: { lt: oneHourAgo },
      },
    },
    include: {
      slotOfAppointment: true,
    },
    take: 100, // Process in batches to avoid overwhelming Stream API
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
          const call = client.video.call("default", session.streamCallId);
          const response = await call.get();

          if (response.call.ended_at) {
            // Stream confirms the call ended
            endedAt = new Date(response.call.ended_at);
            endedReason = "reconciled";
            result.reconciled++;
          } else {
            // Call exists in Stream but no ended_at — use slot end time
            endedAt = new Date(session.slotOfAppointment.endsAt);
            endedReason = "reconciled_no_end";
            result.reconciled++;
          }
        } catch (streamError) {
          // Stream API error or call not found — use slot end time
          endedAt = new Date(session.slotOfAppointment.endsAt);
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
        // Stream not configured — use slot end time
        endedAt = new Date(session.slotOfAppointment.endsAt);
        endedReason = "stream_not_configured";
        result.streamNotFound++;
      }

      await prisma.meetingSession.update({
        where: { id: session.id },
        data: { endedAt, endedReason },
      });

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

export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}

// Allow direct execution
if (require.main === module) {
  (async () => {
    await abortIfMaintenance("reconcile-orphaned-sessions");
    console.log("Starting orphaned session reconciliation...");

    try {
      const result = await reconcileOrphanedSessions();
      console.log("\nReconciliation Results:");
      console.log(`  Processed: ${result.processed}`);
      console.log(`  Reconciled: ${result.reconciled}`);
      console.log(`  Stream Not Found: ${result.streamNotFound}`);
      console.log(`  Errors: ${result.errors}`);
      console.log(`  Success: ${result.success}`);

      if (!result.success) process.exit(1);
    } catch (error) {
      console.error("Fatal error:", error);
      process.exit(1);
    } finally {
      await disconnectDatabase();
    }
  })();
}
