/**
 * Recording Transfer Service
 * Handles transferring recordings from Stream S3 to Supabase for permanent storage
 */

import prisma from "@/lib/prisma";
import { RecordingStatus } from "@prisma/client";
import type { RecordingRow } from "./recording-types";
import { streamLogger } from "@/lib/stream-logger";
import { recordSystemError } from "@/lib/enterprise/system-events";
// #1270 — the leaf module, NOT `@/lib/supabase`. That one opens with
// `import "server-only"`, which throws outside Next's `react-server` resolution
// condition, so every cron that reaches this service — mark-expired-recordings,
// cleanup-old-stream-recordings, transfer-expiring-recordings and
// sweep-stuck-webhook-events — died during module evaluation and none had ever
// completed a run. Same clients, same helpers, no marker.
import {
  ensureBucketExists,
  generateStorageFileName,
} from "@/lib/supabase-storage-core";
import {
  getR2RecordingsBucket,
  isR2Configured,
  streamMultipartToR2,
  uploadR2Object,
} from "@/lib/storage/r2-client";
import {
  deleteRecordingObject,
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
export const MAX_TRANSFER_ATTEMPTS = 5;
const TRANSFER_TIMEOUT_MS = 5 * 60 * 1000;
export const STALE_TRANSFER_MS = 15 * 60 * 1000;

const ALLOWED_STREAM_STORAGE_HOST_SUFFIXES = [
  "cloudfront.net",
  "stream-io-api.com",
  "stream-io-cdn.com",
  "getstream.io",
] as const;

const AWS_S3_HOST_REGEX =
  /^([a-z0-9-]+\.)?s3([.-][a-z0-9-]+)?\.amazonaws\.com$/i;

/**
 * Validate that a recording URL points to an HTTPS Stream/S3/CloudFront host
 * and not an internal, loopback, or link-local address.
 */
export function isAllowedStreamRecordingUrl(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }

  if (parsed.protocol !== "https:") return false;
  if (parsed.username || parsed.password) return false;

  const host = parsed.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host === "0.0.0.0" ||
    host === "::1" ||
    host === "[::1]" ||
    host.startsWith("127.") ||
    host.startsWith("10.") ||
    host.startsWith("192.168.") ||
    host.startsWith("169.254.") ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
  ) {
    return false;
  }

  if (AWS_S3_HOST_REGEX.test(host)) {
    return true;
  }

  return ALLOWED_STREAM_STORAGE_HOST_SUFFIXES.some(
    (suffix) => host === suffix || host.endsWith(`.${suffix}`),
  );
}

type StoragePolicyCarrier = {
  recordingStoragePolicy?: string | null;
} | null;

type AppointmentWithStoragePolicies = {
  webinar?: { webinarPlan?: StoragePolicyCarrier } | null;
  class?: { classPlan?: StoragePolicyCarrier } | null;
  consultation?: { consultationPlan?: StoragePolicyCarrier } | null;
  subscription?: { subscriptionPlan?: StoragePolicyCarrier } | null;
  trial?: { subscriptionPlan?: StoragePolicyCarrier } | null;
} | null;

export function resolveAppointmentStoragePolicy(
  appointment: AppointmentWithStoragePolicies | undefined,
): "PERMANENT" | "SUPABASE_PERMANENT" | "STREAM_ONLY" | null {
  if (!appointment) return null;
  const raw =
    appointment.webinar?.webinarPlan?.recordingStoragePolicy ??
    appointment.class?.classPlan?.recordingStoragePolicy ??
    appointment.consultation?.consultationPlan?.recordingStoragePolicy ??
    appointment.subscription?.subscriptionPlan?.recordingStoragePolicy ??
    appointment.trial?.subscriptionPlan?.recordingStoragePolicy ??
    null;

  if (
    raw === "PERMANENT" ||
    raw === "SUPABASE_PERMANENT" ||
    raw === "STREAM_ONLY"
  ) {
    return raw;
  }
  return null;
}

function createSizeLimitedStream(
  source: ReadableStream<Uint8Array>,
  maxBytes: number,
): ReadableStream<Uint8Array> {
  let bytesRead = 0;
  const limiter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      bytesRead += chunk.byteLength;
      if (bytesRead > maxBytes) {
        controller.error(
          new Error(
            `RECORDING_OBJECT_CEILING: Recording stream exceeded maximum size (${Math.round(maxBytes / 1024 / 1024)}MB)`,
          ),
        );
        return;
      }
      controller.enqueue(chunk);
    },
  });
  return source.pipeThrough(limiter);
}

/**
 * Check whether an upload error represents an unrecoverable payload-too-large
 * rejection (direct 413, ceiling marker, or wrapped in `.cause` / `.originalError`).
 */
export function isPayloadTooLargeUploadError(error: unknown): boolean {
  const visited = new Set<unknown>();
  const matchesSingle = (candidate: unknown): boolean => {
    if (!candidate || typeof candidate !== "object") return false;
    if (visited.has(candidate)) return false;
    visited.add(candidate);
    const obj = candidate as {
      message?: unknown;
      status?: unknown;
      statusCode?: unknown;
      cause?: unknown;
      originalError?: unknown;
    };
    if (
      obj.status === 413 ||
      obj.statusCode === 413 ||
      obj.statusCode === "413"
    ) {
      return true;
    }
    const msg = typeof obj.message === "string" ? obj.message : "";
    if (
      msg.includes("RECORDING_OBJECT_CEILING") ||
      /too large|payload too large|entity too large|exceeded (?:the )?maximum (?:allowed )?size|maximum (?:allowed )?size exceeded/i.test(
        msg,
      )
    ) {
      return true;
    }
    return matchesSingle(obj.cause) || matchesSingle(obj.originalError);
  };
  return matchesSingle(error);
}

/**
 * Build Prisma where-clause to filter recordings by their plan's storage policy.
 * Joins through Recording → Meeting → AppointmentOccurrence → Appointment → Event → Plan.
 */
function buildStoragePolicyFilter(policyFilter: "PERMANENT" | "ALL"): object {
  if (policyFilter === "ALL") return {};

  return {
    meeting: {
      occurrence: {
        appointment: {
          OR: [
            {
              webinar: {
                webinarPlan: {
                  recordingStoragePolicy: "PERMANENT" as const,
                },
              },
            },
            {
              class: {
                classPlan: {
                  recordingStoragePolicy: "PERMANENT" as const,
                },
              },
            },
            {
              consultation: {
                consultationPlan: {
                  recordingStoragePolicy: "PERMANENT" as const,
                },
              },
            },
            {
              subscription: {
                subscriptionPlan: {
                  recordingStoragePolicy: "PERMANENT" as const,
                },
              },
            },
            {
              trial: {
                subscriptionPlan: {
                  recordingStoragePolicy: "PERMANENT" as const,
                },
              },
            },
          ],
        },
      },
    },
  };
}

export class RecordingTransferService {
  /**
   * Queue a recording for transfer to Supabase.
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
   * Record a failed transfer attempt on the Recording row, transition to FAILED
   * once MAX_TRANSFER_ATTEMPTS is reached or when terminal is true, and page
   * engineering once attempts cross the alert threshold.
   */
  private static async recordTransferFailure(
    recordingId: string,
    errorMessage: string,
    opts?: { terminal?: boolean },
  ): Promise<void> {
    try {
      const failureData = {
        status: opts?.terminal ? RecordingStatus.FAILED : RecordingStatus.READY,
        transferAttempts: opts?.terminal
          ? MAX_TRANSFER_ATTEMPTS
          : { increment: 1 },
        lastTransferError: errorMessage,
      };

      let updated: {
        organizationId: string | null;
        transferAttempts: number;
        transferFailureAlertedAt: Date | null;
      } | null = null;

      if (typeof prisma.recording.updateMany === "function") {
        const guarded = await prisma.recording.updateMany({
          where: {
            id: recordingId,
            status: { not: RecordingStatus.AVAILABLE },
          },
          data: failureData,
        });
        if (guarded.count === 0) return;
        updated = await prisma.recording.findUnique({
          where: { id: recordingId },
          select: {
            organizationId: true,
            transferAttempts: true,
            transferFailureAlertedAt: true,
          },
        });
      } else {
        updated = await prisma.recording.update({
          where: { id: recordingId },
          data: failureData,
          select: {
            organizationId: true,
            transferAttempts: true,
            transferFailureAlertedAt: true,
          },
        });
      }

      if (!updated) return;

      if (
        !opts?.terminal &&
        updated.transferAttempts >= MAX_TRANSFER_ATTEMPTS
      ) {
        await prisma.recording.update({
          where: { id: recordingId },
          data: { status: RecordingStatus.FAILED },
        });
      }

      if (
        (opts?.terminal ||
          updated.transferAttempts >= TRANSFER_FAILURE_ALERT_THRESHOLD) &&
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

  private static async claimRecordingForTransfer(
    recordingId: string,
  ): Promise<boolean> {
    const staleCutoff = new Date(Date.now() - STALE_TRANSFER_MS);
    if (typeof prisma.recording.updateMany === "function") {
      const claimed = await prisma.recording.updateMany({
        where: {
          id: recordingId,
          OR: [
            {
              status: {
                in: [RecordingStatus.READY, RecordingStatus.PROCESSING],
              },
            },
            {
              status: "TRANSFERRING" as RecordingStatus,
              updatedAt: { lt: staleCutoff },
            },
          ],
        },
        data: { status: "TRANSFERRING" as RecordingStatus },
      });
      return claimed.count > 0;
    }

    await prisma.recording.update({
      where: { id: recordingId },
      data: { status: "TRANSFERRING" as RecordingStatus },
    });
    return true;
  }

  private static async uploadToR2Storage(params: {
    recordingId: string;
    storagePath: string;
    response: Response;
    contentType: string;
    initialFileSize: bigint | null;
  }): Promise<bigint> {
    const { recordingId, storagePath, response, contentType } = params;
    let fileSize = params.initialFileSize;
    streamLogger.info("Uploading recording to Cloudflare R2", {
      recordingId,
      storagePath,
    });
    const bucket = getR2RecordingsBucket();
    if (response.body) {
      const uploaded = await streamMultipartToR2({
        bucket,
        key: storagePath,
        stream: response.body,
        contentType,
        maxBytes: RECORDING_MAX_OBJECT_BYTES,
      });
      fileSize ??= BigInt(uploaded.size);
      return fileSize;
    }

    const rawBytes = new Uint8Array(await response.arrayBuffer());
    if (rawBytes.byteLength > RECORDING_MAX_OBJECT_BYTES) {
      throw new Error(
        `RECORDING_OBJECT_CEILING: Recording stream exceeded maximum size (${Math.round(RECORDING_MAX_OBJECT_BYTES / 1024 / 1024)}MB)`,
      );
    }
    await uploadR2Object({
      bucket,
      key: storagePath,
      body: rawBytes,
      contentType,
    });
    fileSize ??= BigInt(rawBytes.byteLength);
    return fileSize;
  }

  private static async uploadToSupabaseStorage(params: {
    recordingId: string;
    storagePath: string;
    response: Response;
    contentType: string;
  }): Promise<{ ok: true } | { ok: false; error: string }> {
    const { recordingId, storagePath, response, contentType } = params;
    streamLogger.info("Uploading recording to Supabase", {
      recordingId,
      storagePath,
    });

    const uploadBody = response.body
      ? createSizeLimitedStream(response.body, RECORDING_MAX_OBJECT_BYTES)
      : await response.blob();

    const { error: uploadError } = await storageClient.storage
      .from(RECORDINGS_BUCKET)
      .upload(storagePath, uploadBody, {
        contentType,
        cacheControl: "31536000", // 1 year cache
        upsert: true,
      });

    if (uploadError) {
      streamLogger.error("Failed to upload to Supabase", uploadError, {
        recordingId,
        storagePath,
      });
      await this.recordTransferFailure(
        recordingId,
        uploadError.message,
        isPayloadTooLargeUploadError(uploadError)
          ? { terminal: true }
          : undefined,
      );
      return { ok: false, error: uploadError.message };
    }
    return { ok: true };
  }

  private static async downloadAndUploadRecording(
    recordingId: string,
    recordingUrl: string,
    useR2: boolean,
  ): Promise<
    | { ok: true; storagePath: string; fileSize: bigint | null }
    | { ok: false; error: string }
  > {
    const abortController = new AbortController();
    const timeoutHandle = setTimeout(
      () => abortController.abort(),
      TRANSFER_TIMEOUT_MS,
    );
    try {
      const response = await fetch(recordingUrl, {
        redirect: "error",
        signal: abortController.signal,
      });

      if (!response.ok) {
        const error = `Failed to download recording: ${response.status} ${response.statusText}`;
        await this.recordTransferFailure(recordingId, error);
        return { ok: false, error };
      }

      const contentType = response.headers.get("content-type") || "video/mp4";
      const contentLength = response.headers.get("content-length");
      let fileSize = contentLength ? BigInt(contentLength) : null;
      const fileSizeNumber = contentLength
        ? Number.parseInt(contentLength, 10)
        : null;

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
        return { ok: false, error };
      }

      if (!RECORDING_MIME_TYPES.includes(contentType)) {
        streamLogger.warn("Unexpected content type for recording", {
          recordingId,
          contentType,
        });
      }

      const now = new Date();
      const year = now.getFullYear();
      const month = (now.getMonth() + 1).toString().padStart(2, "0");
      const mimeType = contentType.split(";")[0].trim();
      const filename = generateStorageFileName(mimeType);
      const storagePath = `recordings/${year}/${month}/${recordingId}/${filename}`;

      if (useR2) {
        fileSize = await this.uploadToR2Storage({
          recordingId,
          storagePath,
          response,
          contentType,
          initialFileSize: fileSize,
        });
      } else {
        const uploaded = await this.uploadToSupabaseStorage({
          recordingId,
          storagePath,
          response,
          contentType,
        });
        if (!uploaded.ok) {
          return { ok: false, error: uploaded.error };
        }
      }

      return { ok: true, storagePath, fileSize };
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  private static async completeRecordingTransfer(
    recordingId: string,
    storagePath: string,
    fileSize: bigint | null,
  ): Promise<boolean> {
    const completionData = {
      storagePath,
      storageType: "PLATFORM" as const,
      status: "AVAILABLE" as RecordingStatus,
      transferredAt: new Date(),
      fileSize,
      streamUrlExpiresAt: null,
      transferAttempts: 0,
      lastTransferError: null,
      transferFailureAlertedAt: null,
    };

    if (typeof prisma.recording.updateMany === "function") {
      const completed = await prisma.recording.updateMany({
        where: {
          id: recordingId,
          status: "TRANSFERRING" as RecordingStatus,
        },
        data: completionData,
      });
      if (completed.count === 0) {
        await deleteRecordingObject(storagePath).catch(() => undefined);
        return false;
      }
      return true;
    }

    await prisma.recording.update({
      where: { id: recordingId },
      data: completionData,
    });
    return true;
  }

  /**
   * Transfer a recording from Stream S3 to Supabase
   * @param recordingId The recording ID to transfer
   */
  static async transferRecordingToSupabase(
    recordingId: string,
  ): Promise<{ success: boolean; error?: string }> {
    let recording:
      | (RecordingRow & {
          meeting?: {
            occurrence?: {
              appointment?: AppointmentWithStoragePolicies;
            } | null;
          } | null;
        })
      | null = null;

    try {
      recording = await prisma.recording.findUnique({
        where: { id: recordingId },
        include: {
          meeting: {
            select: {
              occurrence: {
                select: {
                  appointment: {
                    select: {
                      webinar: {
                        select: {
                          webinarPlan: {
                            select: { recordingStoragePolicy: true },
                          },
                        },
                      },
                      class: {
                        select: {
                          classPlan: {
                            select: { recordingStoragePolicy: true },
                          },
                        },
                      },
                      consultation: {
                        select: {
                          consultationPlan: {
                            select: { recordingStoragePolicy: true },
                          },
                        },
                      },
                      subscription: {
                        select: {
                          subscriptionPlan: {
                            select: { recordingStoragePolicy: true },
                          },
                        },
                      },
                      trial: {
                        select: {
                          subscriptionPlan: {
                            select: { recordingStoragePolicy: true },
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

      if (!recording) {
        return { success: false, error: "Recording not found" };
      }

      if (!recording.recordingUrl) {
        return { success: false, error: "Recording URL not available" };
      }

      if (!isAllowedStreamRecordingUrl(recording.recordingUrl)) {
        const error =
          "Recording URL is not from an allowed Stream storage host";
        await this.recordTransferFailure(recordingId, error);
        return { success: false, error };
      }

      const resolvedPolicy = resolveAppointmentStoragePolicy(
        recording.meeting?.occurrence?.appointment,
      );
      if (resolvedPolicy === "STREAM_ONLY") {
        return {
          success: false,
          error: "Recording plan uses STREAM_ONLY storage policy",
        };
      }

      const claimed = await this.claimRecordingForTransfer(recordingId);
      if (!claimed) {
        return {
          success: false,
          error: "Recording is already transferring or transferred",
        };
      }

      const useR2 = isR2Configured();
      if (!useR2) {
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
      }

      streamLogger.info("Downloading recording from Stream", {
        recordingId,
        url: recording.recordingUrl.substring(0, 50) + "...",
      });

      const transferred = await this.downloadAndUploadRecording(
        recordingId,
        recording.recordingUrl,
        useR2,
      );
      if (!transferred.ok) {
        return { success: false, error: transferred.error };
      }

      const finalized = await this.completeRecordingTransfer(
        recordingId,
        transferred.storagePath,
        transferred.fileSize,
      );
      if (!finalized) {
        return {
          success: false,
          error: "Recording transfer claim was superseded before completion",
        };
      }

      streamLogger.info("Recording transferred successfully", {
        recordingId,
        storagePath: transferred.storagePath,
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
      if (recording) {
        await this.recordTransferFailure(
          recordingId,
          errorMessage,
          isPayloadTooLargeUploadError(error) ? { terminal: true } : undefined,
        );
      }
      return { success: false, error: errorMessage };
    }
  }

  /**
   * Process expiring recordings that should be transferred to Supabase.
   * @param policyFilter - "PERMANENT" to only auto-transfer premium plans,
   *                       "ALL" to transfer everything (manual/legacy mode)
   */
  static async processExpiringRecordings(
    daysBeforeExpiry: number = 5,
    batchSize: number = 10,
    policyFilter: "PERMANENT" | "ALL" = "PERMANENT",
  ): Promise<{
    processed: number;
    succeeded: number;
    failed: number;
    errors: string[];
  }> {
    const expiryThreshold = new Date();
    expiryThreshold.setDate(expiryThreshold.getDate() + daysBeforeExpiry);

    const results = {
      processed: 0,
      succeeded: 0,
      failed: 0,
      errors: [] as string[],
    };

    try {
      const stale = await prisma.recording.updateMany({
        where: {
          status: "TRANSFERRING",
          storageType: "STREAM_S3",
          updatedAt: { lt: new Date(Date.now() - STALE_TRANSFER_MS) },
        },
        data: { status: "READY" as RecordingStatus },
      });
      if (stale.count > 0) {
        streamLogger.warn("Reset stale TRANSFERRING recordings to READY", {
          count: stale.count,
        });
      }

      const expiringRecordings = await prisma.recording.findMany({
        where: {
          storageType: "STREAM_S3",
          status: "READY",
          transferAttempts: { lt: MAX_TRANSFER_ATTEMPTS },
          streamUrlExpiresAt: {
            lte: expiryThreshold,
          },
          ...buildStoragePolicyFilter(policyFilter),
        },
        take: batchSize,
        orderBy: {
          streamUrlExpiresAt: "asc",
        },
      });

      streamLogger.info("Processing expiring recordings", {
        count: expiringRecordings.length,
        daysBeforeExpiry,
        policyFilter,
      });

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
      throw error;
    }
  }

  /**
   * Count permanent-policy recordings still on Stream S3 with less
   * than `hoursBeforeExpiry` of URL life left.
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
   */
  static async getExpiringStreamOnlyRecordings(
    daysBeforeExpiry: number = 3,
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
    const staleCutoff = new Date(Date.now() - STALE_TRANSFER_MS);

    if (typeof prisma.recording.updateMany === "function") {
      await prisma.recording
        .updateMany({
          where: {
            status: "TRANSFERRING",
            storageType: "STREAM_S3",
            updatedAt: { lt: staleCutoff },
          },
          data: { status: "READY" as RecordingStatus },
        })
        .catch(() => undefined);
    }

    const recordings = await prisma.recording.findMany({
      where: {
        storageType: "STREAM_S3",
        OR: [
          { status: "READY" },
          {
            status: "TRANSFERRING" as RecordingStatus,
            updatedAt: { lt: staleCutoff },
          },
        ],
        streamUrlExpiresAt: {
          lte: expiryThreshold,
          gt: new Date(), // Not yet expired
        },
        meeting: {
          occurrence: {
            appointment: {
              OR: [
                {
                  webinar: {
                    webinarPlan: {
                      recordingStoragePolicy: "STREAM_ONLY",
                    },
                  },
                },
                {
                  class: {
                    classPlan: {
                      recordingStoragePolicy: "STREAM_ONLY",
                    },
                  },
                },
                {
                  consultation: {
                    consultationPlan: {
                      recordingStoragePolicy: "STREAM_ONLY",
                    },
                  },
                },
                {
                  subscription: {
                    subscriptionPlan: {
                      recordingStoragePolicy: "STREAM_ONLY",
                    },
                  },
                },
                {
                  trial: {
                    subscriptionPlan: {
                      recordingStoragePolicy: "STREAM_ONLY",
                    },
                  },
                },
              ],
            },
          },
        },
      },
      include: {
        meeting: {
          include: {
            occurrence: {
              include: {
                appointment: {
                  include: {
                    webinar: {
                      include: {
                        webinarPlan: {
                          include: { consultantProfile: true },
                        },
                      },
                    },
                    class: {
                      include: {
                        classPlan: {
                          include: { consultantProfile: true },
                        },
                      },
                    },
                    consultation: {
                      include: {
                        consultationPlan: {
                          include: { consultantProfile: true },
                        },
                      },
                    },
                    subscription: {
                      include: {
                        subscriptionPlan: {
                          include: { consultantProfile: true },
                        },
                      },
                    },
                    trial: {
                      include: {
                        subscriptionPlan: {
                          include: { consultantProfile: true },
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

    return recordings.map((r) => {
      const apt = r.meeting.occurrence.appointment;
      const consultantUserId =
        apt.webinar?.webinarPlan?.consultantProfile?.userId ||
        apt.class?.classPlan?.consultantProfile?.userId ||
        apt.consultation?.consultationPlan?.consultantProfile?.userId ||
        apt.subscription?.subscriptionPlan?.consultantProfile?.userId ||
        apt.trial?.subscriptionPlan?.consultantProfile?.userId ||
        "";
      return {
        recordingId: r.id,
        title: r.title,
        consultantUserId,
        expiresAt: r.streamUrlExpiresAt!,
      };
    });
  }

  /**
   * Mark expired Stream S3 recordings
   * This should be run as a cron job to mark recordings whose URLs have expired
   */
  static async markExpiredRecordings(): Promise<number> {
    try {
      const now = new Date();

      const result = await prisma.recording.updateMany({
        where: {
          storageType: "STREAM_S3",
          status: "READY",
          streamUrlExpiresAt: {
            lt: now,
          },
        },
        data: {
          status: "EXPIRED" as RecordingStatus,
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
   * Delete a recording from platform storage
   * @param recordingId The recording ID to delete
   */
  static async deleteRecordingFromSupabase(
    recordingId: string,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const recording = await prisma.recording.findUnique({
        where: { id: recordingId },
      });

      if (!recording) {
        return { success: false, error: "Recording not found" };
      }

      if (!recording.storagePath) {
        return { success: false, error: "Recording not stored in Supabase" };
      }

      const deleted = await deleteRecordingObject(recording.storagePath);
      if (!deleted.success) {
        return { success: false, error: deleted.error };
      }

      // Update recording record
      await prisma.recording.update({
        where: { id: recordingId },
        data: {
          storageUrl: null,
          storagePath: null,
          storageType: "STREAM_S3",
          status:
            recording.streamUrlExpiresAt &&
            recording.streamUrlExpiresAt < new Date()
              ? "EXPIRED"
              : "READY",
        },
      });

      streamLogger.info("Recording deleted from Supabase", {
        recordingId,
        path: recording.storagePath,
      });

      return { success: true };
    } catch (error) {
      const errorMessage =
        error instanceof Error
          ? error.message
          : "Unknown error during deletion";
      streamLogger.error("Failed to delete recording from Supabase", error, {
        recordingId,
      });
      return { success: false, error: errorMessage };
    }
  }
}
