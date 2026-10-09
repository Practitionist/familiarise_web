/**
 * Mid-session decline discard for 1:1 sessions: a DECLINED consent decided at
 * or before the recording ended means the recording must not exist anywhere.
 */

import { RecordingConsentDecision, RecordingStatus } from "@prisma/client";
import prisma from "@/lib/prisma";
import { streamLogger } from "@/lib/stream-logger";
import {
  getStreamVideoClient,
  isExpectedStreamError,
  withStreamCircuitBreaker,
} from "@/lib/stream-client";
import { STREAM_CALL_TYPE, toCallId } from "@/lib/stream/call-cid";
import { consentRegimeFor } from "@/lib/stream/recording-consent";
import type { AppointmentWithOwnership } from "@/lib/stream/recording-utils";
import { deleteRecordingAssets } from "@/lib/stream/recording-storage";

/** True for a 1:1 meeting where someone declined at or before `endTime`. */
export async function wasDeclinedDuringRecording(
  meetingId: string,
  appointment: AppointmentWithOwnership | null | undefined,
  endTime: Date,
): Promise<boolean> {
  if (consentRegimeFor(appointment) !== "OPT_OUT") return false;
  if (!Number.isFinite(endTime.getTime())) return false;
  const declined = await prisma.recordingConsent.count({
    where: {
      meetingId,
      decision: RecordingConsentDecision.DECLINED,
      decidedAt: { lte: endTime },
    },
  });
  return declined > 0;
}

/**
 * Expire any row for this file and delete Stream's copy. Safe to retry: rows
 * already EXPIRED are skipped and a recording Stream no longer has is a no-op.
 */
export async function discardDeclinedRecording(args: {
  meetingId: string;
  streamCallId: string;
  sessionId: string | undefined;
  filename: string;
}): Promise<void> {
  const rows = await prisma.recording.findMany({
    where: {
      meetingId: args.meetingId,
      status: { not: RecordingStatus.EXPIRED },
      OR: [
        { streamRecordingId: args.filename },
        {
          streamRecordingId: null,
          status: {
            in: [RecordingStatus.PROCESSING, RecordingStatus.RECORDING],
          },
        },
      ],
    },
    select: { id: true, status: true, storagePath: true },
  });

  for (const row of rows) {
    if (row.storagePath) {
      const deleted = await deleteRecordingAssets(row);
      if (!deleted.success) {
        throw new Error(deleted.error ?? "Failed to delete declined recording");
      }
    }
    await prisma.recording.updateMany({
      where: { id: row.id, status: row.status },
      data: {
        status: RecordingStatus.EXPIRED,
        recordingUrl: "",
        storagePath: null,
      },
    });
  }

  if (!args.sessionId) {
    streamLogger.warn(
      "Declined recording has no session id; Stream copy kept",
      {
        streamCallId: args.streamCallId,
        filename: args.filename,
      },
    );
    return;
  }

  const sessionId = args.sessionId;
  const call = getStreamVideoClient().video.call(
    STREAM_CALL_TYPE,
    toCallId(args.streamCallId),
  );
  try {
    await withStreamCircuitBreaker(() =>
      call.deleteRecording({ session: sessionId, filename: args.filename }),
    );
  } catch (error) {
    if (!isExpectedStreamError(error)) throw error;
  }
  streamLogger.info("Discarded recording after a mid-session decline", {
    streamCallId: args.streamCallId,
    filename: args.filename,
  });
}
