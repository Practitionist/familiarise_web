/**
 * Recording Transfer Service
 * Handles transferring recordings from Stream S3 to Supabase for permanent storage
 */

import prisma from "@/lib/prisma";
import { Recording, RecordingStatus } from "@prisma/client";
import { streamLogger } from "@/lib/stream-logger";
import supabase, { ensureBucketExists } from "@/lib/supabase";

// Recordings bucket name
const RECORDINGS_BUCKET = "recordings";

// Maximum file size for direct transfer (500MB)
// Files larger than this should use resumable uploads (future enhancement)
const MAX_TRANSFER_SIZE = 500 * 1024 * 1024; // 500MB

// Allowed video MIME types
const ALLOWED_VIDEO_TYPES = [
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "video/x-msvideo",
  "application/octet-stream", // Stream may return this
];

/**
 * Recording Transfer Service for moving recordings to permanent storage
 */
export class RecordingTransferService {
  /**
   * Queue a recording for transfer to Supabase
   * @param recordingId The recording ID to queue
   */
  static async queueRecordingTransfer(recordingId: string): Promise<boolean> {
    try {
      // Update status to TRANSFERRING
      await prisma.recording.update({
        where: { id: recordingId },
        data: {
          status: "TRANSFERRING" as RecordingStatus,
        },
      });

      streamLogger.info("Recording queued for transfer", { recordingId });
      return true;
    } catch (error) {
      streamLogger.error("Failed to queue recording for transfer", error, {
        recordingId,
      });
      return false;
    }
  }

  /**
   * Transfer a recording from Stream S3 to Supabase
   * @param recordingId The recording ID to transfer
   */
  static async transferRecordingToSupabase(
    recordingId: string,
  ): Promise<{ success: boolean; error?: string }> {
    let recording: Recording | null = null;

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

      // Update status to TRANSFERRING
      await prisma.recording.update({
        where: { id: recordingId },
        data: { status: "TRANSFERRING" as RecordingStatus },
      });

      // Ensure the recordings bucket exists
      const bucketReady = await ensureBucketExists(RECORDINGS_BUCKET);
      if (!bucketReady) {
        await prisma.recording.update({
          where: { id: recordingId },
          data: { status: "READY" as RecordingStatus },
        });
        return {
          success: false,
          error: `Recordings bucket not found. Please create a '${RECORDINGS_BUCKET}' bucket in Supabase.`,
        };
      }

      // Download the recording from Stream S3
      streamLogger.info("Downloading recording from Stream", {
        recordingId,
        url: recording.recordingUrl.substring(0, 50) + "...",
      });

      const response = await fetch(recording.recordingUrl);

      if (!response.ok) {
        await prisma.recording.update({
          where: { id: recordingId },
          data: { status: "FAILED" as RecordingStatus },
        });
        return {
          success: false,
          error: `Failed to download recording: ${response.status} ${response.statusText}`,
        };
      }

      // Get file data
      const contentType = response.headers.get("content-type") || "video/mp4";
      const contentLength = response.headers.get("content-length");
      const fileSize = contentLength ? BigInt(contentLength) : null;
      const fileSizeNumber = contentLength ? parseInt(contentLength, 10) : null;

      // Check file size before attempting transfer to prevent OOM
      if (fileSizeNumber && fileSizeNumber > MAX_TRANSFER_SIZE) {
        await prisma.recording.update({
          where: { id: recordingId },
          data: { status: "READY" as RecordingStatus }, // Revert to READY
        });
        streamLogger.warn("Recording too large for direct transfer", {
          recordingId,
          fileSize: fileSizeNumber,
          maxSize: MAX_TRANSFER_SIZE,
        });
        return {
          success: false,
          error: `Recording is too large for direct transfer (${Math.round(fileSizeNumber / 1024 / 1024)}MB). Maximum size is 500MB. Large recordings will need to be transferred manually or via a background job.`,
        };
      }

      // Validate content type
      if (!ALLOWED_VIDEO_TYPES.includes(contentType)) {
        streamLogger.warn("Unexpected content type for recording", {
          recordingId,
          contentType,
        });
      }

      // Create file path: recordings/{year}/{month}/{recordingId}/{filename}
      const now = new Date();
      const year = now.getFullYear();
      const month = (now.getMonth() + 1).toString().padStart(2, "0");
      const filename = recording.streamRecordingId || `${recordingId}.mp4`;
      const storagePath = `recordings/${year}/${month}/${recordingId}/${filename}`;

      // Upload to Supabase
      streamLogger.info("Uploading recording to Supabase", {
        recordingId,
        storagePath,
      });

      // Use blob() instead of arrayBuffer() for more efficient memory handling
      // Blob is more memory-efficient in most JS runtimes for large files
      const fileBlob = await response.blob();

      const { error: uploadError } = await supabase.storage
        .from(RECORDINGS_BUCKET)
        .upload(storagePath, fileBlob, {
          contentType,
          cacheControl: "31536000", // 1 year cache
          upsert: true,
        });

      if (uploadError) {
        await prisma.recording.update({
          where: { id: recordingId },
          data: { status: "FAILED" as RecordingStatus },
        });
        streamLogger.error("Failed to upload to Supabase", uploadError, {
          recordingId,
          storagePath,
        });
        return { success: false, error: uploadError.message };
      }

      // Get public URL
      const { data: urlData } = supabase.storage
        .from(RECORDINGS_BUCKET)
        .getPublicUrl(storagePath);

      // Update recording with Supabase details
      await prisma.recording.update({
        where: { id: recordingId },
        data: {
          supabaseUrl: urlData.publicUrl,
          supabasePath: storagePath,
          storageType: "SUPABASE",
          status: "AVAILABLE" as RecordingStatus,
          transferredAt: new Date(),
          fileSize: fileSize,
        },
      });

      streamLogger.info("Recording transferred successfully", {
        recordingId,
        storagePath,
        supabaseUrl: urlData.publicUrl,
      });

      return { success: true };
    } catch (error) {
      // Revert status on error
      if (recording) {
        await prisma.recording.update({
          where: { id: recordingId },
          data: { status: "FAILED" as RecordingStatus },
        });
      }

      const errorMessage =
        error instanceof Error
          ? error.message
          : "Unknown error during transfer";
      streamLogger.error("Failed to transfer recording", error, {
        recordingId,
      });
      return { success: false, error: errorMessage };
    }
  }

  /**
   * Process all recordings that are expiring soon
   * This should be run as a cron job
   * @param daysBeforeExpiry Days before expiry to start transferring
   * @param batchSize Maximum number of recordings to process in one batch
   */
  static async processExpiringRecordings(
    daysBeforeExpiry: number = 3,
    batchSize: number = 10,
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
      // Get recordings that are expiring soon and still on Stream S3
      const expiringRecordings = await prisma.recording.findMany({
        where: {
          storageType: "STREAM_S3",
          status: "READY",
          streamUrlExpiresAt: {
            lte: expiryThreshold,
          },
        },
        take: batchSize,
        orderBy: {
          streamUrlExpiresAt: "asc",
        },
      });

      streamLogger.info("Processing expiring recordings", {
        count: expiringRecordings.length,
        daysBeforeExpiry,
      });

      for (const recording of expiringRecordings) {
        results.processed++;

        const result = await this.transferRecordingToSupabase(recording.id);

        if (result.success) {
          results.succeeded++;
        } else {
          results.failed++;
          results.errors.push(
            `Recording ${recording.id}: ${result.error || "Unknown error"}`,
          );
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
   * Delete a recording from Supabase storage
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

      if (!recording.supabasePath) {
        return { success: false, error: "Recording not stored in Supabase" };
      }

      // Delete from Supabase
      const { error: deleteError } = await supabase.storage
        .from(RECORDINGS_BUCKET)
        .remove([recording.supabasePath]);

      if (deleteError) {
        streamLogger.error("Failed to delete from Supabase", deleteError, {
          recordingId,
          path: recording.supabasePath,
        });
        return { success: false, error: deleteError.message };
      }

      // Update recording record
      await prisma.recording.update({
        where: { id: recordingId },
        data: {
          supabaseUrl: null,
          supabasePath: null,
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
        path: recording.supabasePath,
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

  /**
   * Get the best available URL for a recording
   * Returns Supabase URL if available, otherwise Stream URL
   * @param recording The recording object
   */
  static getBestRecordingUrl(recording: Recording): string | null {
    if (recording.status === "AVAILABLE" && recording.supabaseUrl) {
      return recording.supabaseUrl;
    }

    if (recording.status === "READY" && recording.recordingUrl) {
      return recording.recordingUrl;
    }

    return null;
  }
}

export default RecordingTransferService;
