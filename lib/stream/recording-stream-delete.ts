/**
 * Deletes the copy Stream still holds for one recording segment. Stream keeps
 * its copy for 14 days, so a deletion that only clears our R2 object leaves a
 * playable copy upstream. Safe to retry: a call Stream does not know, or a
 * filename its listing lacks, is already gone. Failures are returned, not
 * reported, so a loop caller reports once per run.
 */

import {
  getStreamVideoClient,
  isExpectedStreamError,
  isStreamConfigured,
  withStreamCircuitBreaker,
} from "@/lib/stream-client";
import { STREAM_CALL_TYPE, toCallId } from "@/lib/stream/call-cid";
import { RecordingService } from "@/lib/stream/recording-service";

export async function deleteStreamRecordingCopy(recording: {
  streamCallId: string | null;
  streamRecordingId: string | null;
}): Promise<{ success: boolean; error?: string }> {
  if (!recording.streamCallId || !recording.streamRecordingId) {
    return { success: true };
  }
  if (!isStreamConfigured()) {
    return { success: false, error: "Stream is not configured" };
  }
  const filename = recording.streamRecordingId;
  const call = getStreamVideoClient().video.call(
    STREAM_CALL_TYPE,
    toCallId(recording.streamCallId),
  );
  try {
    // The delete needs Stream's session id, which only its listing carries.
    const listing = await RecordingService.getCallRecordingsFromStream(
      recording.streamCallId,
    );
    if (listing.status === "call-not-found") return { success: true };
    if (listing.status === "unavailable") {
      return { success: false, error: listing.error };
    }
    const match = listing.recordings.find((r) => r.filename === filename);
    if (!match) return { success: true };
    // The fallback answers an open breaker without a per-call Sentry event.
    const deleted = await withStreamCircuitBreaker(
      async () => {
        await call.deleteRecording({ session: match.session_id, filename });
        return true;
      },
      () => false,
    );
    return deleted
      ? { success: true }
      : { success: false, error: "Stream circuit is open" };
  } catch (error) {
    if (isExpectedStreamError(error)) return { success: true };
    return {
      success: false,
      error: error instanceof Error ? error.message : "Stream delete failed",
    };
  }
}
