/**
 * Full recordings live in R2; preview clips and thumbnails live in the public
 * Supabase `recordings-previews` bucket.
 */

import {
  RecordingStatus,
  RecordingStorageType,
  type Prisma,
} from "@prisma/client";
import { streamLogger } from "@/lib/stream-logger";
import {
  createR2PresignedGetUrl,
  deleteR2Object,
} from "@/lib/storage/r2-client";
// The leaf module: `@/lib/supabase` is server-only and throws in cron processes.
import { adminStorage, removeObjects } from "@/lib/supabase-storage-core";

export const RECORDING_PREVIEWS_BUCKET = "recordings-previews";

/**
 * True once the recording is copied to our bucket and no longer depends on
 * Stream's 14-day copy. Publish, purchase and marketplace listing gate on it.
 */
export function isDurablyOurs(recording: {
  status: string;
  storageType: string;
}): boolean {
  return (
    recording.status === RecordingStatus.AVAILABLE &&
    recording.storageType === RecordingStorageType.PLATFORM
  );
}

/** {@link isDurablyOurs} as a Prisma filter; built per call so callers cannot share a mutable fragment. */
export function durablyOursWhere(): Prisma.RecordingWhereInput {
  return {
    status: RecordingStatus.AVAILABLE,
    storageType: RecordingStorageType.PLATFORM,
  };
}

const MIN_PLAYBACK_URL_TTL_S = 3600;
const MAX_PLAYBACK_URL_TTL_S = 24 * 3600;

/** Twice the recording's length plus an hour, so a paused or rewound watch never outlives its URL. */
export function playbackUrlTtlSeconds(
  durationInMinutes: number | null | undefined,
): number {
  const minutes = durationInMinutes ?? 0;
  if (!Number.isFinite(minutes) || minutes <= 0) return MIN_PLAYBACK_URL_TTL_S;
  return Math.min(
    MAX_PLAYBACK_URL_TTL_S,
    MIN_PLAYBACK_URL_TTL_S + Math.ceil(minutes) * 2 * 60,
  );
}

/** Presigned playback URL for an object in the private recordings bucket. */
export function generateSignedUrl(
  storagePath: string,
  expiresIn: number = MIN_PLAYBACK_URL_TTL_S,
): string | null {
  try {
    return createR2PresignedGetUrl({
      key: storagePath,
      expiresInSeconds: expiresIn,
    });
  } catch (error) {
    streamLogger.error("Failed to generate R2 presigned URL", error, {
      storagePath,
    });
    return null;
  }
}

/**
 * Our copy once AVAILABLE, otherwise Stream's URL while READY or mid-copy.
 * Branches on `status` alone: mid-transfer `storageType` does not yet describe the bytes.
 */
export async function getBestRecordingUrl(recording: {
  status: string;
  storagePath: string | null;
  recordingUrl: string | null;
  durationInMinutes?: number | null;
}): Promise<string | null> {
  if (recording.status === RecordingStatus.AVAILABLE && recording.storagePath) {
    return generateSignedUrl(
      recording.storagePath,
      playbackUrlTtlSeconds(recording.durationInMinutes),
    );
  }

  if (
    (recording.status === RecordingStatus.READY ||
      recording.status === RecordingStatus.TRANSFERRING) &&
    recording.recordingUrl
  ) {
    return recording.recordingUrl;
  }

  return null;
}

/** Delete ONLY the R2 object — callers own the row's status change. */
export async function deleteRecordingObject(
  storagePath: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    const result = await deleteR2Object({ key: storagePath });
    if (!result.success) {
      streamLogger.error(
        "Failed to delete recording object from R2",
        new Error(result.error ?? "R2 delete failed"),
        { path: storagePath },
      );
      return { success: false, error: result.error };
    }
    return { success: true };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to delete from R2";
    streamLogger.error("Failed to delete recording object from R2", error, {
      path: storagePath,
    });
    return { success: false, error: message };
  }
}

/** Remove the recording's preview folder (clip and thumbnail); false means objects may survive. */
async function deleteRecordingPreviews(recordingId: string): Promise<boolean> {
  try {
    const { data, error } = await adminStorage()
      .from(RECORDING_PREVIEWS_BUCKET)
      .list(recordingId);
    if (error) {
      streamLogger.error("Failed to list recording previews", error, {
        recordingId,
      });
      return false;
    }
    return removeObjects(
      RECORDING_PREVIEWS_BUCKET,
      (data ?? []).map((file) => `${recordingId}/${file.name}`),
    );
  } catch (error) {
    streamLogger.error("Failed to delete recording previews", error, {
      recordingId,
    });
    return false;
  }
}

/** Delete every stored asset of a recording: the R2 copy plus its preview clip and thumbnail. */
export async function deleteRecordingAssets(recording: {
  id: string;
  storagePath: string | null;
}): Promise<{ success: boolean; error?: string }> {
  if (recording.storagePath) {
    const main = await deleteRecordingObject(recording.storagePath);
    if (!main.success) return main;
  }
  if (!(await deleteRecordingPreviews(recording.id))) {
    return { success: false, error: "Recording previews were not removed" };
  }
  return { success: true };
}
