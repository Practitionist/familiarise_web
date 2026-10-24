/**
 * Deletes the copy Stream still holds for one recording segment. Stream keeps
 * its copy for 14 days, so a deletion that only clears our R2 object leaves a
 * playable copy upstream. Safe to retry: a filename Stream no longer lists is
 * already gone.
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
    const listed = await RecordingService.getCallRecordingsFromStream(
      recording.streamCallId,
    );
    if (listed === null) {
      return { success: false, error: "Stream listing unavailable" };
    }
    const match = listed.find((r) => r.filename === filename);
    if (!match) return { success: true };
    await withStreamCircuitBreaker(() =>
      call.deleteRecording({ session: match.session_id, filename }),
    );
    return { success: true };
  } catch (error) {
    if (isExpectedStreamError(error)) return { success: true };
    return {
      success: false,
      error: error instanceof Error ? error.message : "Stream delete failed",
    };
  }
}
