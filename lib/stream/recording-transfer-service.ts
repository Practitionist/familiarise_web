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
  "amazonaws.com",
  "cloudfront.net",
  "stream-io-api.com",
  "stream-io-cdn.com",
  "getstream.io",
  "stream.example",
] as const;

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
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
  ) {
    return false;
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
      const updated = await prisma.recording.update({
        where: { id: recordingId },
        data: {
          status: opts?.terminal
            ? RecordingStatus.FAILED
            : RecordingStatus.READY,
          transferAttempts: opts?.terminal
            ? MAX_TRANSFER_ATTEMPTS
            : { increment: 1 },
          lastTransferError: errorMessage,
        },
        select: {
          organizationId: true,
          transferAttempts: true,
          transferFailureAlertedAt: true,
        },
      });

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
      // Get the recording
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

      // Atomically claim READY/PROCESSING (or stale TRANSFERRING > 15m) -> TRANSFERRING
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
        if (claimed.count === 0) {
          return {
            success: false,
            error: "Recording is already transferring or transferred",
          };
        }
      } else {
        await prisma.recording.update({
          where: { id: recordingId },
          data: { status: "TRANSFERRING" as RecordingStatus },
        });
      }

      const useR2 = isR2Configured();
      if (!useR2) {
        // Ensure the recordings bucket exists in Supabase
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

      // Download the recording from Stream S3
      streamLogger.info("Downloading recording from Stream", {
        recordingId,
        url: recording.recordingUrl.substring(0, 50) + "...",
      });

      const abortController = new AbortController();
      const timeoutHandle = setTimeout(
        () => abortController.abort(),
        TRANSFER_TIMEOUT_MS,
      );
      let fileSize: bigint | null = null;
      let storagePath = "";
      try {
        const response = await fetch(recording.recordingUrl, {
          redirect: "error",
          signal: abortController.signal,
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
        fileSize = contentLength ? BigInt(contentLength) : null;
        const fileSizeNumber = contentLength
          ? parseInt(contentLength, 10)
          : null;

        // Check file size before attempting transfer to prevent OOM
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

        // Create file path: recordings/{year}/{month}/{recordingId}/{uuid}.{ext}
        const now = new Date();
        const year = now.getFullYear();
        const month = (now.getMonth() + 1).toString().padStart(2, "0");
        // Strip content-type params (e.g. "video/mp4; charset=utf-8" → "video/mp4")
        const mimeType = contentType.split(";")[0].trim();
        const filename = generateStorageFileName(mimeType);
        storagePath = `recordings/${year}/${month}/${recordingId}/${filename}`;

        if (useR2) {
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
            if (fileSize === null) {
              fileSize = BigInt(uploaded.size);
            }
          } else {
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
            if (fileSize === null) {
              fileSize = BigInt(rawBytes.byteLength);
            }
          }
        } else {
          // Upload to Supabase
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
            // Revert to READY so cron and manual retries can re-attempt
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
            return { success: false, error: uploadError.message };
          }
        }
      } finally {
        clearTimeout(timeoutHandle);
      }

      // Store the path (NOT a public URL) — presigned URLs are generated on access.
      // Clear the failure trail so a recovered recording stops looking stuck.
      await prisma.recording.update({
        where: {
          id: recordingId,
        },
        data: {
          storagePath: storagePath,
          storageType: "PLATFORM",
          status: "AVAILABLE" as RecordingStatus,
          transferredAt: new Date(),
          fileSize: fileSize,
          streamUrlExpiresAt: null,
          transferAttempts: 0,
          lastTransferError: null,
          transferFailureAlertedAt: null,
        },
      });

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
