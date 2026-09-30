/**
 * Recording Transfer Service
 * Handles transferring recordings from Stream S3 to Supabase for permanent storage
 */

import prisma from "@/lib/prisma";
import { RecordingStatus } from "@prisma/client";
import type { RecordingRow } from "./recording-types";
import { streamLogger } from "@/lib/stream-logger";
import {
  recordSystemError,
  recordSystemEvent,
} from "@/lib/enterprise/system-events";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";
// Lazy client construction only — `getStreamVideoClient()` is called inside the
// delete path, never at module scope, because the crons that import this file do
// not all run with STREAM_* configured and a top-level call would kill the whole
// module for them. Same reason `startRecording` in recording-service does it.
import {
  getStreamVideoClient,
  withStreamCircuitBreaker,
} from "@/lib/stream-client";
import { STREAM_CALL_TYPE, toCallId } from "@/lib/stream/call-cid";
import { deleteRecordingObject } from "@/lib/stream/recording-storage";
// The LEAF policy module, NOT `recording-listing-access` — that one imports
// `next/server` and `lib/auth-server` at module scope, and a cron process that
// pulls `better-auth` in through a transitive import dies during module
// evaluation. Same reasoning as reading storage clients from
// `supabase-storage-core` above. See recording-storage-policy.ts.
import {
  appointmentStoragePolicySelect,
  appointmentStoragePolicyWhere,
} from "@/lib/stream/recording-storage-policy";
// #1270 — the leaf module, NOT `@/lib/supabase`. That one opens with
// `import "server-only"`, which throws outside Next's `react-server` resolution
// condition, so every cron that reaches this service — mark-expired-recordings,
// cleanup-old-stream-recordings, transfer-expiring-recordings and
// sweep-stuck-webhook-events — died during module evaluation and none had ever
// completed a run. Same clients, same helpers, no marker.
import { ensureBucketExists } from "@/lib/supabase-storage-core";
import {
  RECORDINGS_BUCKET,
  RECORDING_MAX_OBJECT_BYTES,
  RECORDING_MIME_TYPES,
  storageClient,
} from "./recording-storage";

// #899 — uploads stream (no in-memory buffering), so the pre-flight reject is
// not about memory. It exists to fail fast instead of burning a full upload
// into a server 413, which only works while it matches what the bucket accepts
// — hence one shared constant rather than a second copy of the number.

// STR-2/3 — page engineering once a recording has burned through this many
// transfer attempts. Below the threshold, retries are normal (transient S3 /
// Supabase blips); at/above it the recording is likely stuck and at risk of
// silently expiring, so it warrants a system_events alert.
const TRANSFER_FAILURE_ALERT_THRESHOLD = 3;

/**
 * Wall-clock ceiling on the Stream S3 download.
 *
 * The download was `fetch(url)` with no `AbortSignal` at all, inside the
 * recording_ready webhook's `after()` and inside the cron lock. A hung
 * connection therefore held a serverless invocation — and, in the cron, the
 * `transfer-expiring-recordings` lock — open for as long as the socket
 * tolerated, which is how a 6-hourly sweep stops running at all. It also
 * collided with the 2-hour stale-TRANSFERRING sweep: a transfer that outlived
 * that threshold was reset to READY and relaunched while the first attempt was
 * still streaming.
 *
 * The default is sized against the work, not against the platform: a
 * multi-hundred-MB composite at a slow-but-workable rate is minutes, and
 * anything still streaming after 10 minutes is a dead peer, not a slow one.
 * It must stay comfortably UNDER the 2-hour stale threshold above so a
 * legitimately slow transfer is never the thing that gets its row reset.
 * Tunable per environment because the real ceiling is deployment-specific
 * (the Netlify function wall clock is a separate, tighter number — see the
 * deployment notes; this is the bound on the socket, not on the function).
 */
const DOWNLOAD_TIMEOUT_MS = (() => {
  const raw = Number(process.env.RECORDING_DOWNLOAD_TIMEOUT_MS?.trim());
  return Number.isFinite(raw) && raw > 0 ? raw : 10 * 60 * 1000;
})();

/**
 * Build Prisma where-clause to filter recordings by their plan's storage policy.
 * Joins through Recording → Meeting → AppointmentOccurrence → Appointment → Plan.
 *
 * D5 — this used to inline two arms (`webinar`, `class`) while the manual
 * transfer route resolved all four through `resolveAppointmentStoragePolicy`,
 * so a PERMANENT consultation or subscription plan was permanently
 * STREAM_ONLY to the automatic pipeline: never auto-transferred, never counted
 * by the backlog alert, and still flipped to EXPIRED by markExpiredRecordings.
 * Both shapes now come from one arm list — see
 * `appointmentStoragePolicyWhere` in recording-storage-policy.ts.
 */
function buildStoragePolicyFilter(policyFilter: "PERMANENT" | "ALL"): object {
  if (policyFilter === "ALL") return {};

  return {
    meeting: {
      occurrence: {
        appointment: appointmentStoragePolicyWhere(policyFilter),
      },
    },
  };
}

/**
 * The object key a recording's copy is written to, derived only from the row.
 *
 * D2 — this used to be `recordings/<year>/<month>/<recordingId>/<uuid>.<ext>`
 * where the uuid came from `generateStorageFileName` and the year/month from
 * `new Date()`. Neither is stable across attempts, and the upload passes
 * `upsert: true`, which can only dedupe an identical path. So the 2-hour stale
 * TRANSFERRING sweep below resetting a slow transfer produced this: attempt A
 * writes `<uuid-A>.mp4`, attempt B writes `<uuid-B>.mp4`, the row records B, and
 * A is an orphan object in the bucket that nothing will ever delete — invisible
 * to the retention sweep (which only ever deletes the object named by
 * `storagePath`) and therefore outliving the org's retention window.
 *
 * Deterministic beats delete-the-previous here. A delete would need a second
 * network round trip on the success path and would still race the concurrent
 * attempt (B could delete A's object after A's upload landed, or before it
 * landed, depending on interleaving — and in the "before" interleaving the
 * cleanup deletes B's own object). Deriving the key from the row makes the
 * race harmless instead of trying to win it: both attempts write the same key,
 * `upsert` collapses them, and the only recorded pointer is the only object.
 *
 * Anchors, both from the row and never from the clock: `recordedAt` (Stream's
 * own call start) and `id`. `ext` is the only content-derived input, and the
 * caller reuses an already-recorded extension when one exists, so even a
 * content-type that changes between attempts cannot fork the key.
 */
function recordingObjectKey(
  recordingId: string,
  recordedAt: Date,
  ext: string,
): string {
  // UTC, unlike the local `getFullYear()` this replaced: a key that depends on
  // the Lambda's timezone is not deterministic either.
  const year = recordedAt.getUTCFullYear();
  const month = (recordedAt.getUTCMonth() + 1).toString().padStart(2, "0");
  return `recordings/${year}/${month}/${recordingId}/recording.${ext}`;
}

/** Canonical extension per accepted MIME type, keyed for `recordingObjectKey`. */
const MIME_EXTENSION: Record<string, string> = {
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "video/x-msvideo": "avi",
  // Stream serves some recordings with no specific video type. The extension is
  // cosmetic (playback is a signed URL and the served type comes from the
  // object's stored contentType), so the ambiguous fallback keeps `mp4` rather
  // than minting a different key for the same object.
  "application/octet-stream": "mp4",
};

/**
 * The extension for a transfer attempt: the one already recorded on the row
 * when we have it, else the canonical extension for the served content type.
 */
function resolveObjectExtension(
  contentType: string,
  recordedStoragePath: string | null,
): string {
  const recorded = recordedStoragePath?.match(/\.([a-z0-9]+)$/i)?.[1];
  if (recorded && recordedStoragePath?.startsWith("recordings/"))
    return recorded;
  return MIME_EXTENSION[contentType] ?? "mp4";
}

/** Marker so the upload's catch can tell a ceiling breach from a storage fault. */
const CEILING_BREACH = "RECORDING_OBJECT_CEILING";

/**
 * D3 — count bytes as they stream past, and error the stream once the ceiling
 * is passed. `bytes` is only final after the stream closes, which is why the
 * caller reads it after the upload settles.
 */
function capStream(
  source: ReadableStream<Uint8Array>,
  maxBytes: number,
): { stream: ReadableStream<Uint8Array>; bytes: number } {
  const counter = { bytes: 0 };
  const stream = source.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        counter.bytes += chunk.byteLength;
        if (counter.bytes > maxBytes) {
          controller.error(new Error(CEILING_BREACH));
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );
  // A getter, not a snapshot: `bytes` is only final once the stream closes, so
  // a value copied at wrap time would be 0 and `fileSize` would be stamped with
  // it. The caller reads it after the upload settles.
  return {
    stream,
    get bytes(): number {
      return counter.bytes;
    },
  };
}

function isCeilingBreach(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.message === CEILING_BREACH || err.message.includes(CEILING_BREACH))
  );
}

/**
 * Does this storage failure mean "this object is too big for this bucket"?
 *
 * Deliberately narrow. Retrying is correct for a transient 5xx and wrong for a
 * size clamp, and the two are only distinguishable by the status code or the
 * wording. Everything else keeps the historical revert-to-READY behaviour, so a
 * misclassification can at worst cost one extra retry — whereas a broad match
 * would terminally fail recordings a temporary storage fault had stranded.
 */
function sizeRejection(error: {
  message?: string;
  statusCode?: number;
}): boolean {
  const status = (error as { status?: number }).status;
  const code = (error as { statusCode?: number }).statusCode;
  if (status === 413 || code === 413) return true;
  return /exceed|too large|payload too large|entity too large/i.test(
    error.message ?? "",
  );
}

/**
 * Delete one recording from Stream, by call + filename.
 *
 * Stream's delete is keyed on (call session, filename) — there is no call-level
 * "delete one file" and no call-level delete, so the session id has to come from
 * somewhere. `Recording` does not store it (it stores `streamCallId` and
 * `streamRecordingId`), so the session id is read back off the recording list.
 * Two round trips instead of one; the alternative was either guessing a session
 * id (deleting the wrong file) or a schema column this bucket does not own.
 *
 * Returns false on any failure — a missing Stream app, a network fault, a
 * recording Stream has already expired. Callers treat that as "the vendor copy
 * is on its own clock", which it is: Stream deletes the object fourteen days
 * after the call regardless of whether we ever asked.
 */
async function deleteStreamRecording(
  streamCallId: string,
  filename: string,
): Promise<boolean> {
  try {
    const client = getStreamVideoClient();
    const call = client.video.call(STREAM_CALL_TYPE, toCallId(streamCallId));
    const listed = await withStreamCircuitBreaker(() => call.listRecordings());
    const target = listed.recordings.find((r) => r.filename === filename);
    if (!target) {
      // Already gone from Stream's side — the goal is met.
      return true;
    }
    await withStreamCircuitBreaker(() =>
      call.deleteRecording({
        session: target.session_id,
        filename: target.filename,
      }),
    );
    return true;
  } catch (err) {
    // `warn` takes (message, context) — the error goes in the context, not as a
    // second positional, which is `error`'s shape only.
    streamLogger.warn("Stream-side recording delete failed", {
      error: err instanceof Error ? err.message : String(err),
      streamCallId,
      filename,
    });
    return false;
  }
}

/**
 * The audit a recording deletion owes, in the same shape the retention sweep
 * writes (`STREAM_RECORDING_DELETED`) so an operator delete and a retention
 * tombstone are indistinguishable to whoever reads the trail six months later.
 *
 * Strict: an unlogged deletion of a session recording is not a deletion this
 * system is willing to perform, which is the same contract
 * `auditOperatorRecordingAccess` sets for a privileged read. `recordSystemEvent`
 * is additionally strict, so a failure here propagates to the caller — and the
 * caller (the DELETE route) turns it into a 500 while the caller of THAT can
 * retry, which is safe because the storage object is already gone and
 * `remove` on a missing key is a no-op.
 */
async function recordRecordingDeleted(params: {
  recordingId: string;
  organizationId: string | null;
  meetingId: string | null;
  title: string;
  tombstoned: boolean;
  storageDeleted: boolean;
  streamDeleted: boolean;
}): Promise<void> {
  const details = {
    recordingId: params.recordingId,
    meetingId: params.meetingId,
    title: params.title,
    tombstoned: params.tombstoned,
    storageDeleted: params.storageDeleted,
    streamDeleted: params.streamDeleted,
    source: "operator-delete",
  };
  const summary = `Deleted recording "${params.title}"`;

  if (params.organizationId) {
    await prisma.orgAuditLog.create({
      data: {
        organizationId: params.organizationId,
        // The actor is a platform operator, not a member of this org; the route
        // stamps the identity into `details`.
        actorMembershipId: null,
        category: "SYSTEM",
        action: AUDIT_ACTIONS.SYSTEM.STREAM_RECORDING_DELETED,
        description: summary,
        details,
      },
    });
  }

  await recordSystemEvent({
    organizationId: params.organizationId ?? null,
    category: "STREAM_RECORDING_DELETED",
    severity: "WARN",
    message: summary,
    context: details,
    correlationId: params.recordingId,
    strict: true,
  });
}

export class RecordingTransferService {
  /**
   * Queue a recording for transfer to Supabase.
   *
   * #899 — no broker: "queueing" is an immediate best-effort transfer,
   * fired from the recording_ready webhook so permanent recordings move
   * near-ready instead of near-expiry. Every failure path in
   * transferRecordingToSupabase reverts status to READY, and the stale-
   * TRANSFERRING sweep in processExpiringRecordings recovers kicks that die
   * mid-flight, so the 6-hourly cron always backstops this.
   * @param recordingId The recording ID to queue
   */
  static async queueRecordingTransfer(recordingId: string): Promise<boolean> {
    const { success, error } =
      await this.transferRecordingToSupabase(recordingId);
    if (!success) {
      streamLogger.warn("Ready-time transfer kick failed; cron will retry", {
        recordingId,
        error,
      });
    }
    return success;
  }

  /**
   * STR-2/3 — record a failed transfer attempt on the Recording row and, once
   * attempts cross the threshold, page engineering exactly once.
   *
   * Reverts status to READY (the existing retry contract — see
   * transferRecordingToSupabase docstring), bumps transferAttempts, stamps
   * lastTransferError. When the post-increment count >= the threshold and we
   * have not alerted before (transferFailureAlertedAt null), fires a
   * recordSystemError and stamps transferFailureAlertedAt to dedupe the page.
   *
   * D1 — the write is a conditional `updateMany` fenced on the state this
   * attempt actually claimed (`TRANSFERRING` on `STREAM_S3`), and `count === 0`
   * is a LOST RACE, not a retryable failure. It used to be a bare
   * `update({ where: { id } })`, which raced two other writers holding
   * *different* cron lock keys and so excluding nothing:
   *
   *   - `markExpiredRecordings` flips `READY` + `streamUrlExpiresAt < now` to
   *     EXPIRED. A failure landing just after it resurrected a genuinely dead
   *     row to READY, and `getBestRecordingUrl` then handed the user a Stream
   *     URL whose bytes Stream had already deleted.
   *   - the retention tombstone in cleanup-old-stream-recordings flips a row to
   *     EXPIRED past the org's window. Same resurrection, and worse: the row
   *     went back to READY and the next sweep re-transferred it, so bytes that
   *     should have been purged got copied into the permanent bucket.
   *
   * `terminal` is the D3 escape from the retry-forever loop: a size rejection
   * can never succeed on a retry, so it goes to FAILED (which the transfer
   * candidate query, the retention candidate query and getBestRecordingUrl all
   * exclude) rather than back to READY.
   */
  private static async recordTransferFailure(
    recordingId: string,
    errorMessage: string,
    opts?: { terminal?: boolean },
  ): Promise<void> {
    try {
      // Read the post-write counters inside the same transaction as the
      // conditional write. `updateMany` returns only a count, and the alert
      // decision needs the new attempt number — and the dedupe marker must not
      // be stamped on a row this attempt did not actually claim. No Stream or
      // storage call happens in here, so the interactive transaction is short.
      const updated = await prisma.$transaction(async (tx) => {
        const claimed = await tx.recording.updateMany({
          where: {
            id: recordingId,
            status: RecordingStatus.TRANSFERRING,
            storageType: "STREAM_S3",
          },
          data: {
            status: opts?.terminal
              ? RecordingStatus.FAILED
              : RecordingStatus.READY,
            transferAttempts: { increment: 1 },
            lastTransferError: errorMessage,
          },
        });
        if (claimed.count === 0) return null;
        return tx.recording.findUnique({
          where: { id: recordingId },
          select: {
            organizationId: true,
            transferAttempts: true,
            transferFailureAlertedAt: true,
          },
        });
      });

      if (!updated) {
        // Someone else moved this row out from under the attempt — the retention
        // sweep or the expiry sweep. Writing here is exactly the resurrection
        // this fence exists to prevent.
        streamLogger.warn(
          "Transfer failure discarded — row is no longer ours to revert",
          { recordingId },
        );
        return;
      }

      if (
        updated.transferAttempts >= TRANSFER_FAILURE_ALERT_THRESHOLD &&
        !updated.transferFailureAlertedAt
      ) {
        await recordSystemError({
          organizationId: updated.organizationId ?? null,
          category: "RECORDING_TRANSFER",
          summary: `Recording transfer stuck after ${updated.transferAttempts} attempts`,
          err: new Error(errorMessage),
          context: { recordingId, transferAttempts: updated.transferAttempts },
          correlationId: recordingId,
        });

        // Stamp the dedupe marker only after the page is recorded, so a crash
        // mid-alert re-pages next failure rather than silently swallowing it.
        await prisma.recording.update({
          where: { id: recordingId },
          data: { transferFailureAlertedAt: new Date() },
        });
      }
    } catch (err) {
      // Best-effort: failing to record the failure must not mask the original
      // transfer error the caller is about to return.
      streamLogger.error("Failed to record transfer failure", err, {
        recordingId,
      });
    }
  }

  /**
   * Transfer a recording from Stream S3 to Supabase
   * @param recordingId The recording ID to transfer
   *
   * **Failure strategy:** All failure paths revert status to READY (not FAILED)
   * so that both the cron job and the manual /transfer API endpoint can retry.
   * A FAILED status would permanently dead-end the recording since the manual
   * transfer route only accepts READY recordings. The only exceptions are
   * "bucket missing" and "file too large" which also revert to READY since
   * the underlying issue is environmental, not permanent.
   *
   * D3 supersedes the second exception: an object the bucket will never accept
   * is NOT environmental, it is permanent, and reverting it to READY made the
   * 6-hourly sweep retry the same impossible upload forever while the row's
   * `streamUrlExpiresAt` walked past Stream's own deletion — a silent infinite
   * retry that looked like a working pipeline. Size failures now terminate the
   * row (FAILED). Genuinely environmental failures (a 502 from Stream, a bucket
   * that has not been created yet) still revert to READY.
   *
   * `retired` in the result is not a fault and is not counted as one by the
   * sweep: it means a concurrent retention tombstone or expiry sweep won the
   * row while this attempt was in flight, so the object just uploaded is
   * deleted rather than attached to a row that must not have it.
   */
  static async transferRecordingToSupabase(
    recordingId: string,
  ): Promise<{ success: boolean; error?: string; retired?: boolean }> {
    let recording: RecordingRow | null = null;
    let storagePath: string | null = null;

    try {
      // Get the recording
      recording = await prisma.recording.findUnique({
        where: { id: recordingId },
      });

      if (!recording) {
        return { success: false, error: "Recording not found" };
      }

      if (!recording.recordingUrl) {
        return { success: false, error: "Recording URL not available" };
      }

      // D1 — claim the row with the same conditional-update doctrine the rest of
      // this file uses, and with the fence that makes the two crons' different
      // lock keys harmless: a transfer may only claim a row that is READY and
      // still on Stream S3. `markExpiredRecordings` only ever touches READY and
      // the retention tombstone only ever touches non-EXPIRED rows, so a row that
      // reaches TRANSFERRING here is invisible to both until the final write
      // below puts it back.
      const claimed = await prisma.recording.updateMany({
        where: {
          id: recordingId,
          status: RecordingStatus.READY,
          storageType: "STREAM_S3",
        },
        data: { status: RecordingStatus.TRANSFERRING },
      });
      if (claimed.count === 0) {
        // Another attempt already holds it, or the row was retired between the
        // read above and here. Either way this attempt owns nothing.
        return {
          success: false,
          error: "Recording is not in a transferable state",
        };
      }

      // Ensure the recordings bucket exists
      const bucketReady = await ensureBucketExists(RECORDINGS_BUCKET, {
        public: false,
        allowedMimeTypes: RECORDING_MIME_TYPES,
        fileSizeLimit: RECORDING_MAX_OBJECT_BYTES,
      });
      if (!bucketReady) {
        const error = `Recordings bucket not found. Please create a '${RECORDINGS_BUCKET}' bucket in Supabase.`;
        await this.recordTransferFailure(recordingId, error);
        return { success: false, error };
      }

      // Download the recording from Stream S3
      streamLogger.info("Downloading recording from Stream", {
        recordingId,
        url: recording.recordingUrl.substring(0, 50) + "...",
      });

      // D3 — bounded. An `AbortSignal.timeout` is the only thing that turns a
      // half-open socket into a failure instead of an invocation that never
      // returns; see DOWNLOAD_TIMEOUT_MS for why it sits where it does.
      const response = await fetch(recording.recordingUrl, {
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      });

      if (!response.ok) {
        // Revert to READY so cron and manual retries can re-attempt
        const error = `Failed to download recording: ${response.status} ${response.statusText}`;
        await this.recordTransferFailure(recordingId, error);
        return { success: false, error };
      }

      // Get file data
      const contentType = response.headers.get("content-type") || "video/mp4";
      const contentLength = response.headers.get("content-length");
      const fileSizeNumber = contentLength ? parseInt(contentLength, 10) : null;

      // D3 — the size guard used to read `if (fileSizeNumber && …)`, so a
      // chunked response with no `content-length` skipped the check entirely
      // and the whole body streamed into the upload, where the Supabase FREE
      // plan's 50MB clamp rejected it. Worse, the rejection took the generic
      // path: `recordTransferFailure` put the row back to READY, and the sweep
      // re-attempted the same impossible upload every six hours until Stream
      // deleted the source. The guard is now honest in both directions: reject
      // a declared oversize before spending the download, and count the stream
      // when nothing was declared.
      if (fileSizeNumber && fileSizeNumber > RECORDING_MAX_OBJECT_BYTES) {
        streamLogger.warn("Recording too large for direct transfer", {
          recordingId,
          fileSize: fileSizeNumber,
          maxSize: RECORDING_MAX_OBJECT_BYTES,
        });
        const error = `Recording is too large for direct transfer (${Math.round(fileSizeNumber / 1024 / 1024)}MB). Maximum is ${Math.round(RECORDING_MAX_OBJECT_BYTES / 1024 / 1024)}MB.`;
        await this.recordTransferFailure(recordingId, error, {
          terminal: true,
        });
        return { success: false, error };
      }

      // Validate content type
      if (!RECORDING_MIME_TYPES.includes(contentType)) {
        streamLogger.warn("Unexpected content type for recording", {
          recordingId,
          contentType,
        });
      }

      // D2 — deterministic key. See recordingObjectKey: the uuid-per-attempt
      // name was what left an orphan object in the bucket every time the
      // stale-TRANSFERRING sweep below relaunched a still-running transfer.
      const ext = resolveObjectExtension(contentType, recording.storagePath);
      storagePath = recordingObjectKey(recordingId, recording.recordedAt, ext);

      // Upload to Supabase
      streamLogger.info("Uploading recording to Supabase", {
        recordingId,
        storagePath,
      });

      // #899 — pipe the download straight into the storage upload instead of
      // materializing the file (response.blob() buffered up to 500MB in
      // memory). storage-js accepts ReadableStream and sets duplex:"half"
      // itself; blob() is only the fallback for a body-less response.
      const source = response.body;
      const bodyless = source === null;
      // D3 — the no-`content-length` case, made explicit. A counting
      // TransformStream errors the moment the cumulative read passes the
      // ceiling, so an oversized chunked body fails DURING the upload rather
      // than after streaming all of it into a bucket that was always going to
      // reject it. The same counter is what lets `fileSize` be stamped for a
      // response that declared no length — previously null forever for exactly
      // those recordings, which is the whole class of recording most likely to
      // trip the FREE plan's 50MB clamp.
      //
      // `blob()` is deliberately not wrapped: it has already been materialized
      // in memory, so counting it would only discover the oversize after paying
      // for the bytes. The pre-flight `content-length` check is the only guard
      // there, which is the same trade the old code made.
      const capped = source
        ? capStream(source, RECORDING_MAX_OBJECT_BYTES)
        : null;
      const uploadInput: ReadableStream<Uint8Array> | Blob =
        capped?.stream ?? (source === null ? await response.blob() : source);
      let uploadError: { message: string } | null = null;
      try {
        const upload = await storageClient.storage
          .from(RECORDINGS_BUCKET)
          .upload(storagePath, uploadInput, {
            contentType,
            cacheControl: "31536000", // 1 year cache
            upsert: true,
          });
        uploadError = upload.error;
      } catch (thrown) {
        // The cap surfaces as a throw (a stream error is not an `{ error }`
        // return); storage-js surfaces its own failures as `{ error }`. Only
        // the former is the ceiling, and only it is terminal.
        if (!isCeilingBreach(thrown)) throw thrown;
        const error = `Recording exceeds the ${Math.round(RECORDING_MAX_OBJECT_BYTES / 1024 / 1024)}MB object ceiling and cannot be transferred.`;
        streamLogger.warn(error, { recordingId, storagePath });
        await this.recordTransferFailure(recordingId, error, {
          terminal: true,
        });
        return { success: false, error };
      }

      if (uploadError) {
        streamLogger.error("Failed to upload to Supabase", uploadError, {
          recordingId,
          storagePath,
        });
        // D3 — a bucket-level size rejection is the FREE-plan clamp doing
        // exactly what the comment in recording-storage.ts warns it will, and
        // the same object will be rejected identically forever. Retrying it
        // every six hours is what made this look like a healthy pipeline.
        // Classify narrowly: only a size rejection is terminal, so a transient
        // 5xx from storage still reverts to READY and gets another go.
        await this.recordTransferFailure(
          recordingId,
          uploadError.message,
          sizeRejection(uploadError) ? { terminal: true } : undefined,
        );
        return { success: false, error: uploadError.message };
      }

      // Bytes actually handed to storage — the declared length when there was
      // one, otherwise what the counter saw. Null only for a body-less response
      // that declared no length, which is what the old code always produced.
      const uploadedBytes = bodyless
        ? fileSizeNumber
        : (capped?.bytes ?? fileSizeNumber);

      // D1 — the success write is fenced the same way the claim was. A bare
      // `update({ where: { id } })` here resurrected rows the retention
      // tombstone had just retired: the transfer finished, flipped the row back
      // to AVAILABLE/PLATFORM with a live storagePath, and the object it named
      // was one the retention sweep had never deleted (it only tombstones rows
      // whose storagePath was still null) — so the bytes outlived the org's
      // retention window. That is a DPDP violation, and the row then became
      // permanently invisible to the tombstone's own `status notIn [EXPIRED,
      // FAILED]` candidate filter, so nothing would ever clean it up.
      const stored = await prisma.recording.updateMany({
        where: {
          id: recordingId,
          status: RecordingStatus.TRANSFERRING,
          storageType: "STREAM_S3",
        },
        data: {
          storagePath: storagePath,
          storageType: "PLATFORM",
          status: RecordingStatus.AVAILABLE,
          transferredAt: new Date(),
          fileSize:
            uploadedBytes === null ? null : BigInt(Math.max(uploadedBytes, 0)),
          // D7 — clear the whole failure trail, not just the error string. A row
          // that recovered after five attempts kept `transferAttempts: 5`, so
          // its very next single failure re-tripped the >=3 page and paged
          // again on every subsequent blip.
          transferAttempts: 0,
          lastTransferError: null,
          transferFailureAlertedAt: null,
        },
      });

      if (stored.count === 0) {
        // Lost the race. The object we just wrote belongs to a row that must not
        // have it, so delete it rather than orphaning it in the bucket.
        const purged = await deleteRecordingObject(storagePath);
        streamLogger.warn(
          "Transfer completed but the row was retired mid-flight; object discarded",
          {
            recordingId,
            storagePath,
            objectDeleted: purged.success,
          },
        );
        return {
          success: false,
          retired: true,
          error:
            "Recording was retired while the transfer was in flight; the copied object was deleted.",
        };
      }

      streamLogger.info("Recording transferred successfully", {
        recordingId,
        storagePath,
      });

      return { success: true };
    } catch (error) {
      const errorMessage =
        error instanceof Error
          ? error.message
          : "Unknown error during transfer";
      streamLogger.error("Failed to transfer recording", error, {
        recordingId,
      });
      // Revert to READY + track the attempt so cron/manual retries can re-attempt
      // (only when the recording row was actually loaded — otherwise nothing to bump).
      if (recording) {
        await this.recordTransferFailure(recordingId, errorMessage);
      }
      return { success: false, error: errorMessage };
    }
  }

  /**
   * Process all recordings that are expiring soon
   * This should be run as a cron job
   * @param daysBeforeExpiry Days before expiry to start transferring
   * @param batchSize Maximum number of recordings to process in one batch
   */
  /**
   * Process expiring recordings that should be transferred to Supabase.
   * @param policyFilter - "PERMANENT" to only auto-transfer premium plans,
   *                       "ALL" to transfer everything (manual/legacy mode)
   *
   * `batchSize` moved from 10 to 25 (D7). Ten per tick at four ticks a day is
   * forty transfers a day with no queue behind it, so a single day of sessions
   * produced a permanent backlog: every recording that missed the window lost
   * its bytes at Stream's fourteen-day deletion, and the only signal was a
   * backlog count nothing was paging on. 25 at the existing concurrency of 3
   * is nine sequential chunks of network-bound work — still far inside the
   * workflow budget, and the sweep's own `countAtRiskPermanentRecordings`
   * alarm is what covers a backlog that outruns even this.
   */
  static async processExpiringRecordings(
    daysBeforeExpiry: number = 5,
    batchSize: number = 25,
    policyFilter: "PERMANENT" | "ALL" = "PERMANENT",
  ): Promise<{
    processed: number;
    succeeded: number;
    failed: number;
    /**
     * Rows a retention tombstone or the expiry sweep retired while this batch
     * held them. Counted separately from `failed` on purpose: the transfer did
     * everything asked of it, and reporting it as a failure would make a healthy
     * sweep exit non-zero every time the two crons overlapped.
     */
    retired: number;
    errors: string[];
  }> {
    const expiryThreshold = new Date();
    expiryThreshold.setDate(expiryThreshold.getDate() + daysBeforeExpiry);

    const results = {
      processed: 0,
      succeeded: 0,
      failed: 0,
      retired: 0,
      errors: [] as string[],
    };

    try {
      // #899 — recover transfers killed mid-flight (serverless webhook kick,
      // crashed cron run): TRANSFERRING with no update for 2h is stuck, and
      // nothing else ever revisits it. Revert to READY so this sweep retries.
      //
      // D2 — the reason the two-hour window has to be comfortably longer than
      // DOWNLOAD_TIMEOUT_MS above, and not merely "eventually": resetting a
      // transfer that is still running launches a second one, and only a
      // deterministic object key keeps that from leaving an orphan in the
      // bucket (see recordingObjectKey). The two changes are load-bearing
      // together — neither is sufficient on its own, so do not shorten this
      // window to schedule more transfers.
      const stale = await prisma.recording.updateMany({
        where: {
          status: RecordingStatus.TRANSFERRING,
          storageType: "STREAM_S3",
          updatedAt: { lt: new Date(Date.now() - 2 * 60 * 60 * 1000) },
        },
        data: { status: RecordingStatus.READY },
      });
      if (stale.count > 0) {
        streamLogger.warn("Reset stale TRANSFERRING recordings to READY", {
          count: stale.count,
        });
      }

      const expiringRecordings = await prisma.recording.findMany({
        where: {
          storageType: "STREAM_S3",
          status: RecordingStatus.READY,
          streamUrlExpiresAt: {
            lte: expiryThreshold,
          },
          ...buildStoragePolicyFilter(policyFilter),
        },
        take: batchSize,
        orderBy: {
          streamUrlExpiresAt: "asc",
        },
        // D7 — the sweep only ever reads the id (it re-loads each row through
        // transferRecordingToSupabase, which is the single writer), so loading
        // every column of every candidate is pure transfer cost.
        select: { id: true },
      });

      streamLogger.info("Processing expiring recordings", {
        count: expiringRecordings.length,
        daysBeforeExpiry,
        policyFilter,
      });

      // #899 — network-bound transfers in chunks of 3: cuts sweep latency
      // without piling memory/connection pressure onto one invocation.
      // transferRecordingToSupabase never throws, so Promise.all is safe.
      const CONCURRENCY = 3;
      for (let i = 0; i < expiringRecordings.length; i += CONCURRENCY) {
        const chunk = expiringRecordings.slice(i, i + CONCURRENCY);
        const outcomes = await Promise.all(
          chunk.map(async (recording) => ({
            id: recording.id,
            result: await this.transferRecordingToSupabase(recording.id),
          })),
        );

        for (const { id, result } of outcomes) {
          results.processed++;
          if (result.success) {
            results.succeeded++;
          } else if (result.retired) {
            results.retired++;
            results.errors.push(
              `Recording ${id}: ${result.error || "Retired mid-transfer"}`,
            );
          } else {
            results.failed++;
            results.errors.push(
              `Recording ${id}: ${result.error || "Unknown error"}`,
            );
          }
        }
      }

      streamLogger.info("Finished processing expiring recordings", results);

      return results;
    } catch (error) {
      streamLogger.error("Failed to process expiring recordings", error);
      return results;
    }
  }

  /**
   * #899 — count permanent-policy recordings still on Stream S3 with less
   * than `hoursBeforeExpiry` of URL life left. Non-zero after a sweep means
   * the pipeline is falling behind or failing repeatedly; the transfer job
   * pages on it before the bytes lapse.
   */
  static async countAtRiskPermanentRecordings(
    hoursBeforeExpiry: number = 72,
  ): Promise<number> {
    const threshold = new Date(Date.now() + hoursBeforeExpiry * 60 * 60 * 1000);
    return prisma.recording.count({
      where: {
        storageType: "STREAM_S3",
        status: "READY",
        streamUrlExpiresAt: { lte: threshold, gt: new Date() },
        ...buildStoragePolicyFilter("PERMANENT"),
      },
    });
  }

  /**
   * Get STREAM_ONLY recordings that are expiring soon (for notification purposes).
   * These won't be auto-transferred but consultants should be warned.
   *
   * D5 — the filter now resolves all four plan arms, so a STREAM_ONLY
   * *consultation* or *subscription* gets the warning its plan asked for. It
   * used to hard-code two arms, so the one-sidedness of the D5 bug ran both
   * ways: PERMANENT 1:1 plans were never transferred AND STREAM_ONLY 1:1 plans
   * were never warned that their recording was about to vanish. The warning
   * mattered most for exactly the case that got no warning.
   *
   * D7 — `take` plus a `select` instead of a five-arm `include`. This runs
   * inside the cron lock on a 6-hourly tick with no upper bound and no
   * per-org cap, and the `include` pulled two full consultant profiles plus
   * every plan column per row for four fields of output. The cap is a warning
   * budget, not a correctness budget: a consultant with more expiring
   * recordings than the cap gets a count and a soonest deadline in the first
   * `take` rows (ordered soonest-first, so the soonest is always in the batch)
   * and the rest are picked up on the next tick.
   */
  static async getExpiringStreamOnlyRecordings(
    daysBeforeExpiry: number = 3,
    take: number = 500,
  ): Promise<
    {
      recordingId: string;
      title: string;
      consultantUserId: string;
      expiresAt: Date;
    }[]
  > {
    const expiryThreshold = new Date();
    expiryThreshold.setDate(expiryThreshold.getDate() + daysBeforeExpiry);

    const recordings = await prisma.recording.findMany({
      where: {
        storageType: "STREAM_S3",
        status: RecordingStatus.READY,
        streamUrlExpiresAt: {
          lte: expiryThreshold,
          gt: new Date(), // Not yet expired
        },
        meeting: {
          occurrence: {
            appointment: appointmentStoragePolicyWhere("STREAM_ONLY"),
          },
        },
      },
      take,
      orderBy: { streamUrlExpiresAt: "asc" },
      select: {
        id: true,
        title: true,
        streamUrlExpiresAt: true,
        meeting: {
          select: {
            occurrence: {
              select: {
                appointment: {
                  select: {
                    ...appointmentStoragePolicySelect,
                    consultation: {
                      select: {
                        consultationPlan: {
                          select: {
                            consultantProfile: { select: { userId: true } },
                          },
                        },
                      },
                    },
                    subscription: {
                      select: {
                        subscriptionPlan: {
                          select: {
                            consultantProfile: { select: { userId: true } },
                          },
                        },
                      },
                    },
                    webinar: {
                      select: {
                        webinarPlan: {
                          select: {
                            consultantProfile: { select: { userId: true } },
                          },
                        },
                      },
                    },
                    class: {
                      select: {
                        classPlan: {
                          select: {
                            consultantProfile: { select: { userId: true } },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    return recordings.flatMap((r) => {
      const apt = r.meeting.occurrence.appointment;
      const consultantUserId =
        apt.consultation?.consultationPlan?.consultantProfile?.userId ||
        apt.subscription?.subscriptionPlan?.consultantProfile?.userId ||
        apt.webinar?.webinarPlan?.consultantProfile?.userId ||
        apt.class?.classPlan?.consultantProfile?.userId ||
        "";
      // No consultant to notify and no deadline to report: dropping it here
      // keeps the notification budget for rows that can actually produce a bell.
      if (!consultantUserId || !r.streamUrlExpiresAt) return [];
      return [
        {
          recordingId: r.id,
          title: r.title,
          consultantUserId,
          expiresAt: r.streamUrlExpiresAt,
        },
      ];
    });
  }

  /**
   * Mark expired Stream S3 recordings
   * This should be run as a cron job to mark recordings whose URLs have expired
   *
   * D5 — deliberately NO storage-policy filter here, and that is the point, not
   * an oversight. This sweep is not asking "should this recording have been
   * kept?"; it is asking "has the source already evaporated?". A PERMANENT
   * recording whose transfer has not happened yet has the same dead Stream URL
   * as a STREAM_ONLY one, and leaving it READY would keep
   * `getBestRecordingUrl` handing users a 404 with an expiry date in the
   * future. The D5 fix is upstream of this: those rows get transferred while
   * their URL is still live, so they are `AVAILABLE`/`PLATFORM` by the time this
   * runs and this filter (`storageType: STREAM_S3`) never sees them. Do not
   * "fix" the D5 symptom by filtering here.
   *
   * The fence is `status: READY` + `storageType: STREAM_S3`, which is what makes
   * this safe to run concurrently with a transfer: a row a transfer has claimed
   * is TRANSFERRING and is skipped, and a transfer that finishes first has left
   * STREAM_S3 so it is skipped too. That two-sided exclusion is only real
   * because transferRecordingToSupabase fences BOTH its writes the same way.
   */
  static async markExpiredRecordings(): Promise<number> {
    try {
      const now = new Date();

      const result = await prisma.recording.updateMany({
        where: {
          storageType: "STREAM_S3",
          status: RecordingStatus.READY,
          streamUrlExpiresAt: {
            lt: now,
          },
        },
        data: {
          status: RecordingStatus.EXPIRED,
        },
      });

      if (result.count > 0) {
        streamLogger.warn("Marked recordings as expired", {
          count: result.count,
        });
      }

      return result.count;
    } catch (error) {
      streamLogger.error("Failed to mark expired recordings", error);
      return 0;
    }
  }

  /**
   * Delete a recording: our Supabase object, Stream's copy, and the row's claim
   * to either — plus the audit trail, in the same transaction as the row flip.
   *
   * D6 — this replaces `deleteRecordingFromSupabase`, which had zero call sites
   * anywhere in the repo and therefore implied a capability nobody had: there
   * was no user-facing or admin delete for a Supabase-copied recording, no
   * Stream-side delete at all, and no path that reached a `Recording` for a DPDP
   * erasure. A dead method that names a delete is worse than no method: the next
   * reader assumes the capability exists.
   *
   * The order is load-bearing and is the same lesson `deleteRecordingObject`
   * carries: the storage delete happens FIRST and outside the transaction, and
   * only a delete that succeeded earns the row flip. A flip that outran its
   * object would leave an EXPIRED row pointing at bytes that are still in the
   * bucket — orphaned storage, and invisible to the retention sweep, whose
   * candidate filter excludes EXPIRED rows.
   *
   * The row is tombstoned (EXPIRED, pointers cleared, `storageType` back to
   * STREAM_S3), not deleted: the row is audit and financial-linkage continuity
   * for a replay that may already have been sold, and `RecordingPurchase`
   * cascades from it. `recordingUrl` is left alone because the column is
   * NOT NULL — the Stream URL it holds is dead either way, and EXPIRED is what
   * stops it being served.
   *
   * Stream's own copy is deleted on a best-effort basis. It expires on its own
   * within fourteen days and the vendor API is a network call that must not sit
   * inside the transaction; its failure is reported, not fatal, because the
   * record we are obliged to keep is ours and the audit row is what matters.
   */
  static async deleteRecording(recordingId: string): Promise<{
    success: boolean;
    error?: string;
    storageDeleted: boolean;
    streamDeleted: boolean;
  }> {
    const recording = await prisma.recording.findUnique({
      where: { id: recordingId },
      select: {
        id: true,
        title: true,
        status: true,
        storageType: true,
        storagePath: true,
        streamCallId: true,
        streamRecordingId: true,
        organizationId: true,
        meeting: { select: { id: true } },
      },
    });

    if (!recording) {
      return {
        success: false,
        error: "Recording not found",
        storageDeleted: false,
        streamDeleted: false,
      };
    }

    let storageDeleted = false;
    if (recording.storagePath) {
      const purged = await deleteRecordingObject(recording.storagePath);
      if (!purged.success) {
        // Refuse to tombstone: an EXPIRED row whose object is still in the
        // bucket is exactly the orphan the DPDP gap is about.
        return {
          success: false,
          error: `Storage delete failed: ${purged.error}`,
          storageDeleted: false,
          streamDeleted: false,
        };
      }
      storageDeleted = true;
    }

    // Stream-side delete, outside the transaction (never a network call inside
    // one) and best-effort — Stream expires the object inside fourteen days
    // regardless, so failing to reach it now is not a reason to refuse, and the
    // vendor's own lifecycle is the backstop the audit row can honestly rely on.
    let streamDeleted = false;
    if (recording.streamCallId && recording.streamRecordingId) {
      streamDeleted = await deleteStreamRecording(
        recording.streamCallId,
        recording.streamRecordingId,
      );
    }

    // #1829 — fence the tombstone on the `storagePath` that was READ, not just on
    // the id. The delete above is a network call against a value captured before
    // it, and a transfer can complete inside that window:
    //
    //   1. findUnique reads `storagePath: null` (a transfer is in flight).
    //   2. The transfer finishes: its fenced success write sets `storagePath`,
    //      `PLATFORM` and `AVAILABLE`, and the object is now in our bucket.
    //   3. This tombstone clears `storagePath` and writes EXPIRED.
    //
    // The object the transfer just uploaded is now unreachable: the row says
    // there is nothing in storage, so no sweep will ever delete it, and it
    // outlives whatever retention the delete was invoked to enforce. That is the
    // same orphan class the retention sweep fix above exists to close, reachable
    // from a different door.
    //
    // Matching on the exact value we read makes the interleaving detectable
    // instead of destructive: `count === 0` means the row moved under us, and
    // the caller must re-read rather than tombstone a row it no longer
    // understands.
    const tombstoned = await prisma.recording.updateMany({
      where: { id: recordingId, storagePath: recording.storagePath },
      data: {
        status: RecordingStatus.EXPIRED,
        storageUrl: null,
        storagePath: null,
        storageType: "STREAM_S3",
      },
    });

    await recordRecordingDeleted({
      recordingId,
      organizationId: recording.organizationId,
      meetingId: recording.meeting?.id ?? null,
      title: recording.title,
      tombstoned: tombstoned.count > 0,
      storageDeleted,
      streamDeleted,
    });

    if (tombstoned.count === 0) {
      streamLogger.warn(
        "Recording delete lost its CAS — the row changed under us, nothing tombstoned",
        { recordingId, storageDeleted, streamDeleted },
      );
      return {
        success: false,
        error:
          "Recording changed during deletion — nothing was tombstoned. Re-read and retry.",
        storageDeleted,
        streamDeleted,
      };
    }

    streamLogger.info("Recording deleted", {
      recordingId,
      storageDeleted,
      streamDeleted,
    });

    return { success: true, storageDeleted, streamDeleted };
  }
}
