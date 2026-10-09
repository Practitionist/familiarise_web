/**
 * Copies READY recordings from Stream's 14-day copy into R2; a failed copy
 * leaves the row READY (still playable from Stream) until the attempt cap.
 */

import { randomUUID } from "node:crypto";
import prisma from "@/lib/prisma";
import { RecordingStatus, RecordingStorageType } from "@prisma/client";
import { streamLogger } from "@/lib/stream-logger";
import { withCronLock } from "@/lib/cron/with-cron-lock";
import { reportSentryMessage } from "@/lib/observability/report";
import {
  deleteR2Object,
  headR2Object,
  streamMultipartToR2,
} from "@/lib/storage/r2-client";

const MAX_TRANSFER_ATTEMPTS = 5;
const STALE_TRANSFER_MS = 15 * 60 * 1000;
/** Below STALE_TRANSFER_MS so a live copy is never reclaimed as stale. */
const TRANSFER_TIMEOUT_MS = 12 * 60 * 1000;
/** Stream splits recordings at two hours (~2 GB), so this only stops a runaway body. */
const RECORDING_MAX_OBJECT_BYTES = 20 * 1024 * 1024 * 1024;
const TRANSFER_BATCH_SIZE = 10;
const TRANSFER_CONCURRENCY = 2;
/** No new copy starts after this, so a run fits the 45-minute workflow step. */
const RUN_BUDGET_MS = 25 * 60 * 1000;
const TRANSFER_LOCK_TTL_MS = 45 * 60 * 1000;

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

type TransferOutcome =
  | { status: "copied" }
  | { status: "skipped" }
  | { status: "failed"; error: string };

interface TransferRunResult {
  processed: number;
  succeeded: number;
  failed: number;
  exhaustedReported: number;
  errors: string[];
}

function parseContentLength(header: string | null): number | null {
  if (!header) return null;
  const parsed = Number(header);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

async function claimForTransfer(recordingId: string): Promise<boolean> {
  const claimed = await prisma.recording.updateMany({
    where: {
      id: recordingId,
      status: RecordingStatus.READY,
      storageType: RecordingStorageType.STREAM_S3,
      transferAttempts: { lt: MAX_TRANSFER_ATTEMPTS },
      streamUrlExpiresAt: { gt: new Date() },
    },
    data: { status: RecordingStatus.TRANSFERRING },
  });
  return claimed.count > 0;
}

/** Return the claimed row to READY and count the attempt. */
async function recordTransferFailure(
  recordingId: string,
  error: string,
): Promise<void> {
  await prisma.recording.updateMany({
    where: { id: recordingId, status: RecordingStatus.TRANSFERRING },
    data: {
      status: RecordingStatus.READY,
      transferAttempts: { increment: 1 },
      lastTransferError: error.slice(0, 1000),
    },
  });
}

/**
 * Pipe Stream's copy into R2 and verify the stored size against the bytes
 * streamed and the source Content-Length. Any failure after upload deletes the object.
 */
async function copyToR2(
  recordingId: string,
  recordingUrl: string,
): Promise<{ storagePath: string; fileSize: number }> {
  if (!isAllowedStreamRecordingUrl(recordingUrl)) {
    throw new Error("Recording URL is not from an allowed Stream storage host");
  }

  const abortController = new AbortController();
  const timeout = setTimeout(
    () => abortController.abort(),
    TRANSFER_TIMEOUT_MS,
  );
  try {
    const response = await fetch(recordingUrl, {
      redirect: "error",
      signal: abortController.signal,
    });
    if (!response.ok) {
      throw new Error(
        `Failed to download recording: ${response.status} ${response.statusText}`,
      );
    }
    if (!response.body) {
      throw new Error("Stream returned an empty recording body");
    }

    const sourceBytes = parseContentLength(
      response.headers.get("content-length"),
    );
    if (sourceBytes !== null && sourceBytes > RECORDING_MAX_OBJECT_BYTES) {
      throw new Error(
        `Recording exceeds the size ceiling (${sourceBytes} bytes)`,
      );
    }

    const storagePath = `recordings/${recordingId}/${randomUUID()}.mp4`;
    const uploaded = await streamMultipartToR2({
      key: storagePath,
      stream: response.body,
      contentType:
        response.headers.get("content-type")?.split(";")[0].trim() ||
        "video/mp4",
      maxBytes: RECORDING_MAX_OBJECT_BYTES,
    });

    try {
      const stored = await headR2Object({ key: storagePath });
      if (
        stored?.contentLength !== uploaded.size ||
        (sourceBytes !== null && sourceBytes !== uploaded.size)
      ) {
        throw new Error(
          `Size mismatch: streamed ${uploaded.size}, stored ${stored?.contentLength ?? "none"}, source ${sourceBytes ?? "unknown"}`,
        );
      }
    } catch (error) {
      await deleteR2Object({ key: storagePath }).catch(() => undefined);
      throw error;
    }

    return { storagePath, fileSize: uploaded.size };
  } finally {
    clearTimeout(timeout);
  }
}

/** Copy one recording. Only a READY row with a live Stream URL is claimed. */
export async function transferRecording(
  recordingId: string,
): Promise<TransferOutcome> {
  if (!(await claimForTransfer(recordingId))) return { status: "skipped" };

  try {
    const row = await prisma.recording.findUnique({
      where: { id: recordingId },
      select: { recordingUrl: true },
    });
    if (!row?.recordingUrl) throw new Error("Recording URL not available");

    const { storagePath, fileSize } = await copyToR2(
      recordingId,
      row.recordingUrl,
    );

    const completed = await prisma.recording.updateMany({
      where: { id: recordingId, status: RecordingStatus.TRANSFERRING },
      data: {
        storagePath,
        storageType: RecordingStorageType.PLATFORM,
        status: RecordingStatus.AVAILABLE,
        transferredAt: new Date(),
        fileSize: BigInt(fileSize),
        streamUrlExpiresAt: null,
        transferAttempts: 0,
        lastTransferError: null,
        transferFailureAlertedAt: null,
      },
    });
    if (completed.count === 0) {
      await deleteR2Object({ key: storagePath }).catch(() => undefined);
      return { status: "skipped" };
    }
    return { status: "copied" };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown transfer error";
    streamLogger.warn("Recording copy failed; row stays READY", {
      recordingId,
      error: message,
    });
    await recordTransferFailure(recordingId, message);
    return { status: "failed", error: message };
  }
}

/** Report rows that hit the attempt cap once per run, then stamp them so later runs stay quiet. */
async function reportExhaustedTransfers(): Promise<number> {
  const exhausted = await prisma.recording.findMany({
    where: {
      storageType: RecordingStorageType.STREAM_S3,
      status: RecordingStatus.READY,
      transferAttempts: { gte: MAX_TRANSFER_ATTEMPTS },
      transferFailureAlertedAt: null,
    },
    select: { id: true, lastTransferError: true },
    take: 100,
  });
  if (exhausted.length === 0) return 0;

  reportSentryMessage(
    `${exhausted.length} recording(s) exhausted copy attempts; Stream's copy will lapse`,
    {
      subsystem: "stream",
      op: "transfer-recordings",
      level: "error",
      fingerprint: ["transfer-recordings", "exhausted"],
      extra: {
        recordings: exhausted.map((r) => ({
          id: r.id,
          lastTransferError: r.lastTransferError,
        })),
      },
    },
  );
  await prisma.recording.updateMany({
    where: {
      id: { in: exhausted.map((r) => r.id) },
      transferFailureAlertedAt: null,
    },
    data: { transferFailureAlertedAt: new Date() },
  });
  return exhausted.length;
}

async function transferChunked(
  candidates: { id: string }[],
  startedAt: number,
  result: TransferRunResult,
): Promise<void> {
  for (let i = 0; i < candidates.length; i += TRANSFER_CONCURRENCY) {
    if (Date.now() - startedAt > RUN_BUDGET_MS) return;
    const chunk = candidates.slice(i, i + TRANSFER_CONCURRENCY);
    const outcomes = await Promise.all(
      chunk.map(async ({ id }) => ({
        id,
        outcome: await transferRecording(id),
      })),
    );
    for (const { id, outcome } of outcomes) {
      if (outcome.status === "skipped") continue;
      result.processed++;
      if (outcome.status === "copied") {
        result.succeeded++;
      } else {
        result.failed++;
        result.errors.push(`Recording ${id}: ${outcome.error}`);
      }
    }
  }
}

async function transferRecordingsUnlocked(
  maxRows: number,
): Promise<TransferRunResult> {
  const startedAt = Date.now();
  const result: TransferRunResult = {
    processed: 0,
    succeeded: 0,
    failed: 0,
    exhaustedReported: 0,
    errors: [],
  };

  // A crashed run leaves its claim behind; hand those rows back.
  await prisma.recording.updateMany({
    where: {
      status: RecordingStatus.TRANSFERRING,
      storageType: RecordingStorageType.STREAM_S3,
      updatedAt: { lt: new Date(startedAt - STALE_TRANSFER_MS) },
    },
    data: { status: RecordingStatus.READY },
  });

  // Batches repeat until the budget or the backlog runs out; a row already tried this run is not retried.
  const attempted: string[] = [];
  while (
    attempted.length < maxRows &&
    Date.now() - startedAt <= RUN_BUDGET_MS
  ) {
    const candidates = await prisma.recording.findMany({
      where: {
        status: RecordingStatus.READY,
        storageType: RecordingStorageType.STREAM_S3,
        transferAttempts: { lt: MAX_TRANSFER_ATTEMPTS },
        streamUrlExpiresAt: { gt: new Date() },
        ...(attempted.length > 0 && { id: { notIn: [...attempted] } }),
      },
      orderBy: { streamUrlExpiresAt: "asc" },
      take: Math.min(TRANSFER_BATCH_SIZE, maxRows - attempted.length),
      select: { id: true },
    });
    if (candidates.length === 0) break;
    attempted.push(...candidates.map((c) => c.id));
    await transferChunked(candidates, startedAt, result);
  }

  result.exhaustedReported = await reportExhaustedTransfers();
  streamLogger.info("transfer-recordings finished", {
    processed: result.processed,
    succeeded: result.succeeded,
    failed: result.failed,
    exhaustedReported: result.exhaustedReported,
  });
  return result;
}

/** Copy READY recordings soonest-expiring first until the run budget, or `limit` rows, is spent. */
export async function transferRecordings(
  opts: { limit?: number } = {},
): Promise<TransferRunResult> {
  return withCronLock(
    "transfer-recordings",
    { failMode: "open", ttlMs: TRANSFER_LOCK_TTL_MS },
    () => transferRecordingsUnlocked(opts.limit ?? Number.POSITIVE_INFINITY),
  );
}
