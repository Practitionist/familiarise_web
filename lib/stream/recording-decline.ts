/**
 * Mid-session decline discard for 1:1 sessions: a DECLINED consent decided at
 * or before the recording ended means the recording must not exist anywhere.
 */

import {
  type Prisma,
  RecordingConsentDecision,
  RecordingStatus,
} from "@prisma/client";
import prisma from "@/lib/prisma";
import { createRunFailureReporter } from "@/lib/observability/run-failures";
import { streamLogger } from "@/lib/stream-logger";
import { consentRegimeFor } from "@/lib/stream/recording-consent";
import type { AppointmentWithOwnership } from "@/lib/stream/recording-utils";
import { purgeExpiredRecordingAssets } from "@/lib/stream/recording-retention";

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

const DECLINED_ROW_SELECT = {
  id: true,
  storagePath: true,
  previewClipStoragePath: true,
  thumbnailUrl: true,
  streamCallId: true,
  streamRecordingId: true,
} satisfies Prisma.RecordingSelect;

type DeclinedRow = Prisma.RecordingGetPayload<{
  select: typeof DECLINED_ROW_SELECT;
}>;

/** Puts the filename on one expired pre-ready row so expire-recordings can retry Stream's copy. */
async function stampDeclinedFilename(
  expired: DeclinedRow[],
  streamCallId: string,
  filename: string,
): Promise<DeclinedRow | null> {
  const unnamed = expired.find((row) => row.streamRecordingId === null);
  if (!unnamed) return null;
  try {
    const [stamped] = await prisma.recording.updateManyAndReturn({
      where: {
        id: unnamed.id,
        status: RecordingStatus.EXPIRED,
        streamRecordingId: null,
      },
      data: { streamRecordingId: filename, streamCallId },
      select: DECLINED_ROW_SELECT,
    });
    return stamped ?? null;
  } catch (error) {
    // Another row already holds this file; it carries the retry instead.
    const unique =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "P2002";
    if (unique) return null;
    throw error;
  }
}

/**
 * Expire any row for this file, delete its assets and Stream's copy. Safe to
 * retry: rows already EXPIRED are skipped and a recording Stream no longer has is a no-op.
 */
export async function discardDeclinedRecording(args: {
  meetingId: string;
  streamCallId: string;
  filename: string;
}): Promise<void> {
  // Expire before deleting: a copy finishing concurrently then misses its
  // TRANSFERRING CAS and deletes its own upload.
  const expired = await prisma.recording.updateManyAndReturn({
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
    data: {
      status: RecordingStatus.EXPIRED,
      recordingUrl: "",
      removedAt: new Date(),
      removalReason: "DECLINED",
    },
    select: DECLINED_ROW_SELECT,
  });

  const carrier =
    expired.find((row) => row.streamRecordingId === args.filename) ??
    (await stampDeclinedFilename(expired, args.streamCallId, args.filename));
  const rows = expired.map((row) => (row.id === carrier?.id ? carrier : row));

  const failures = createRunFailureReporter("stream");
  for (const row of rows) {
    if (
      !row.storagePath &&
      !row.previewClipStoragePath &&
      !row.thumbnailUrl &&
      !row.streamRecordingId
    ) {
      continue;
    }
    const purged = await purgeExpiredRecordingAssets(row, failures);
    if (!purged.success) {
      streamLogger.warn("Declined recording assets left for the expiry sweep", {
        recordingId: row.id,
        error: purged.error,
      });
    }
  }
  failures.flush();

  if (!carrier) {
    // No row carries the filename, so nothing would retry a failed delete.
    const { deleteStreamRecordingCopy } =
      await import("@/lib/stream/recording-stream-delete");
    const deleted = await deleteStreamRecordingCopy({
      streamCallId: args.streamCallId,
      streamRecordingId: args.filename,
    });
    if (!deleted.success) {
      throw new Error(
        deleted.error ?? "Stream copy of a declined recording not deleted",
      );
    }
  }
  streamLogger.info("Discarded recording after a mid-session decline", {
    streamCallId: args.streamCallId,
    filename: args.filename,
  });
}
