/**
 * Recording storage access — the bucket handle, playback URL minting, object
 * deletion, and the single definition of "this recording is durably ours".
 *
 * Split out of `recording-transfer-service.ts` (#1280). That file is the
 * download-then-reupload pipeline and is scheduled for deletion once Stream
 * writes recordings straight into our bucket via `recording_external_storage`.
 * Everything here has to outlive it: `getBestRecordingUrl` is what mints
 * playback for a *paid* replay, so shipping the storage change without moving
 * it first would take the marketplace down with the pipeline.
 */

import type { Prisma } from "@prisma/client";
import { streamLogger } from "@/lib/stream-logger";
// The leaf module, NOT `@/lib/supabase` — that one opens with
// `import "server-only"`, which throws outside Next's `react-server` condition
// and killed every cron that reached it (#1270).
import { supabase, supabaseAdmin } from "@/lib/supabase-storage-core";

export const RECORDINGS_BUCKET = "recordings";

/** Admin client bypasses RLS; the bucket is private so playback needs signing. */
export const storageClient = supabaseAdmin || supabase;

/**
 * Is this recording durably in our custody, rather than on Stream's clock?
 *
 * Stream deletes its own copy after fourteen days, so a recording that is only
 * there cannot back a sold replay. Three surfaces gate on that — publish,
 * purchase, and the marketplace listing query — and each carried its own copy
 * of the pair `status === "AVAILABLE" && storageType === "PLATFORM"`, which
 * spells the vendor into the business rule and drifts three ways.
 *
 * Callers pass `status` explicitly because the route loader renames the column
 * to `recordingStatus` to avoid colliding with its own result discriminant.
 */
export function isDurablyOurs(recording: {
  status: string;
  storageType: string;
}): boolean {
  return (
    recording.status === "AVAILABLE" && recording.storageType === "PLATFORM"
  );
}

/**
 * The same rule as a Prisma filter, for queries that cannot load a row first.
 *
 * Built fresh per call rather than exported as a shared object: where-fragments
 * get spread into query objects all over this codebase, and a frozen-looking
 * module constant is one careless mutation away from corrupting every other
 * caller's query. Same reasoning as `dmEligibleStatusFilter()`.
 */
export function durablyOursWhere(): Prisma.RecordingWhereInput {
  return { status: "AVAILABLE", storageType: "PLATFORM" };
}

/**
 * Presigned playback URL. The bucket is private, so this is the only way a
 * client reaches the bytes.
 */
export async function generateSignedUrl(
  storagePath: string,
  expiresIn: number = 3600,
): Promise<string | null> {
  const { data, error } = await storageClient.storage
    .from(RECORDINGS_BUCKET)
    .createSignedUrl(storagePath, expiresIn);

  if (error || !data?.signedUrl) {
    streamLogger.error("Failed to generate signed URL", error, { storagePath });
    return null;
  }

  return data.signedUrl;
}

/**
 * Best available playback URL: a signed URL once the bytes are ours, otherwise
 * Stream's temporary one.
 *
 * Branches on `status` alone, deliberately — a row mid-transfer has a
 * `storageType` that does not yet describe where the bytes actually are.
 */
export async function getBestRecordingUrl(recording: {
  status: string;
  storagePath: string | null;
  recordingUrl: string | null;
}): Promise<string | null> {
  if (recording.status === "AVAILABLE" && recording.storagePath) {
    return generateSignedUrl(recording.storagePath);
  }

  if (recording.status === "READY" && recording.recordingUrl) {
    return recording.recordingUrl;
  }

  return null;
}

/**
 * Delete ONLY the storage object — no DB side effects.
 *
 * Retention cleanup (#899) needs the row's status flip and the OrgAuditLog
 * write to land atomically in its own transaction. Tombstoning here would flip
 * status before the audit write, and the cleanup candidate query filters
 * `status notIn [EXPIRED, FAILED]`, so a failed audit write would never be
 * retried and the trail would be lost permanently.
 */
export async function deleteRecordingObject(
  storagePath: string,
): Promise<{ success: boolean; error?: string }> {
  const { error } = await storageClient.storage
    .from(RECORDINGS_BUCKET)
    .remove([storagePath]);
  if (error) {
    streamLogger.error("Failed to delete recording object", error, {
      path: storagePath,
    });
    return { success: false, error: error.message };
  }
  return { success: true };
}
