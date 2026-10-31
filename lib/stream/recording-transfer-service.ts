/**
 * Copies READY recordings from Stream's 14-day copy into R2; a failed copy
 * leaves the row READY (still playable from Stream) until the attempt cap.
 */

import prisma, { type Db } from "@/lib/prisma";
import {
  RecordingStatus,
  RecordingStorageType,
  type Prisma,
} from "@prisma/client";
import { streamLogger } from "@/lib/stream-logger";
import { withCronLock } from "@/lib/cron/with-cron-lock";
import { reportSentryMessage } from "@/lib/observability/report";
import { mapBounded } from "@/lib/stream/batch";
import {
  deleteR2Object,
  headR2Object,
  streamMultipartToR2,
} from "@/lib/storage/r2-client";

export const MAX_TRANSFER_ATTEMPTS = 12;
const TRANSFER_RETRY_BACKOFF_MS = [
  15 * 60 * 1000,
  60 * 60 * 1000,
  6 * 60 * 60 * 1000,
  24 * 60 * 60 * 1000,
] as const;
const STALE_TRANSFER_MS = 15 * 60 * 1000;
/** Below STALE_TRANSFER_MS so a live copy is never reclaimed as stale. */
const TRANSFER_TIMEOUT_MS = 12 * 60 * 1000;
/** Stream splits recordings at two hours (~2 GB), so this only stops a runaway body. */
const RECORDING_MAX_OBJECT_BYTES = 20 * 1024 * 1024 * 1024;
/** One copy plus database/cleanup headroom fits the 15-minute background ceiling. */
const TRANSFER_LOCK_TTL_MS = 15 * 60 * 1000;

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
  success: boolean;
  reclaimedStale: number;
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

export function transferRetryBackoffMs(attempts: number): number {
  if (attempts <= 0) return 0;
  const idx = Math.min(attempts - 1, TRANSFER_RETRY_BACKOFF_MS.length - 1);
  return TRANSFER_RETRY_BACKOFF_MS[idx];
}

function retryEligibleWhere(now: Date) {
  return [
    { transferAttempts: 0 },
    {
      transferAttempts: 1,
      updatedAt: { lt: new Date(now.getTime() - TRANSFER_RETRY_BACKOFF_MS[0]) },
    },
    {
      transferAttempts: 2,
      updatedAt: { lt: new Date(now.getTime() - TRANSFER_RETRY_BACKOFF_MS[1]) },
    },
    {
      transferAttempts: 3,
      updatedAt: { lt: new Date(now.getTime() - TRANSFER_RETRY_BACKOFF_MS[2]) },
    },
    {
      transferAttempts: { gte: 4, lt: MAX_TRANSFER_ATTEMPTS },
      updatedAt: { lt: new Date(now.getTime() - TRANSFER_RETRY_BACKOFF_MS[3]) },
    },
  ];
}

interface ClaimedTransfer {
  id: string;
  recordingUrl: string;
  transferAttempts: number;
  updatedAt: Date;
}

async function claimForTransfer(
  recordingId: string,
): Promise<ClaimedTransfer | null> {
  const now = new Date();
  const [claimed] = await prisma.recording.updateManyAndReturn({
    where: {
      id: recordingId,
      status: RecordingStatus.READY,
      storageType: RecordingStorageType.STREAM_S3,
      transferAttempts: { lt: MAX_TRANSFER_ATTEMPTS },
      streamUrlExpiresAt: { gt: now },
      OR: retryEligibleWhere(now),
    },
    data: {
      status: RecordingStatus.TRANSFERRING,
      transferAttempts: { increment: 1 },
    },
    select: {
      id: true,
      recordingUrl: true,
      transferAttempts: true,
      updatedAt: true,
    },
  });
  return claimed ?? null;
}

/** A stale worker can neither publish nor release a newer claim. */
function claimedWhere(claim: ClaimedTransfer) {
  return {
    id: claim.id,
    status: RecordingStatus.TRANSFERRING,
    transferAttempts: claim.transferAttempts,
    updatedAt: claim.updatedAt,
  };
}

async function recordTransferFailure(
  claim: ClaimedTransfer,
  error: string,
): Promise<void> {
  await prisma.recording.updateMany({
    where: claimedWhere(claim),
    data: {
      status: RecordingStatus.READY,
      lastTransferError: error.slice(0, 1000),
    },
  });
}

export function recordingAttemptStoragePath(
  recordingId: string,
  attempt: number,
): string {
  return `recordings/${recordingId}/attempt-${attempt}.mp4`;
}

/** Best-effort removal of superseded MP4 keys from earlier transfer attempts once AVAILABLE commits. */
async function cleanupPriorTransferAttempts(
  recordingId: string,
  winningAttempt: number,
): Promise<void> {
  if (winningAttempt <= 1) return;
  const priorKeys = Array.from({ length: winningAttempt - 1 }, (_, idx) =>
    recordingAttemptStoragePath(recordingId, idx + 1),
  );
  await Promise.all(
    priorKeys.map((key) =>
      deleteR2Object({ key, signal: AbortSignal.timeout(15_000) }).catch(
        () => undefined,
      ),
    ),
  );
}

/**
 * Pipe Stream's copy into an attempt-isolated R2 object key and verify stored bytes.
 * Attempt-scoped keys prevent a stale timed-out cleanup from deleting another worker's published MP4.
 */
async function copyToR2(
  recordingId: string,
  recordingUrl: string,
  attempt: number,
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

    const storagePath = recordingAttemptStoragePath(recordingId, attempt);
    const uploaded = await streamMultipartToR2({
      key: storagePath,
      stream: response.body,
      contentType:
        response.headers.get("content-type")?.split(";")[0].trim() ||
        "video/mp4",
      maxBytes: RECORDING_MAX_OBJECT_BYTES,
      signal: abortController.signal,
    });

    try {
      const stored = await headR2Object({
        key: storagePath,
        signal: abortController.signal,
      });
      if (
        stored?.contentLength !== uploaded.size ||
        (sourceBytes !== null && sourceBytes !== uploaded.size)
      ) {
        throw new Error(
          `Size mismatch: streamed ${uploaded.size}, stored ${stored?.contentLength ?? "none"}, source ${sourceBytes ?? "unknown"}`,
        );
      }
    } catch (error) {
      await deleteR2Object({
        key: storagePath,
        signal: AbortSignal.timeout(15_000),
      }).catch(() => undefined);
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
  const claim = await claimForTransfer(recordingId);
  if (!claim) return { status: "skipped" };

  try {
    if (!claim.recordingUrl) throw new Error("Recording URL not available");
    const { storagePath, fileSize } = await copyToR2(
      recordingId,
      claim.recordingUrl,
      claim.transferAttempts,
    );

    const completed = await prisma.recording.updateMany({
      where: claimedWhere(claim),
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
      const deleted = await deleteR2Object({
        key: storagePath,
        signal: AbortSignal.timeout(15_000),
      }).catch((error: unknown) => ({
        success: false,
        error:
          error instanceof Error ? error.message : "Unknown R2 cleanup error",
      }));
      if (!deleted.success) {
        return {
          status: "failed",
          error: `Unpublished recording attempt cleanup failed: ${deleted.error ?? "R2 delete failed"}`,
        };
      }
      return { status: "skipped" };
    }
    await cleanupPriorTransferAttempts(recordingId, claim.transferAttempts);
    return { status: "copied" };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown transfer error";
    streamLogger.warn("Recording copy failed", {
      recordingId,
      error: message,
    });
    await recordTransferFailure(claim, message);
    return { status: "failed", error: message };
  }
}

/** A source not alarmed within the six-hour cooldown. */
function alertDueWhere(now: Date) {
  return {
    OR: [
      { transferFailureAlertedAt: null },
      {
        transferFailureAlertedAt: {
          lte: new Date(now.getTime() - 6 * 60 * 60 * 1000),
        },
      },
    ],
  };
}

/** Live sources due an alarm: expiring within 72 hours or three attempts consumed. */
function transferRiskWhere(now: Date): Prisma.RecordingWhereInput {
  return {
    storageType: RecordingStorageType.STREAM_S3,
    status: RecordingStatus.READY,
    streamUrlExpiresAt: { gt: now },
    AND: [alertDueWhere(now)],
    OR: [
      {
        streamUrlExpiresAt: {
          lte: new Date(now.getTime() + 72 * 60 * 60 * 1000),
        },
      },
      { transferAttempts: { gte: 3 } },
    ],
  };
}

/** Claims throttle each live source to one alarm per six hours, including manual replays. */
async function reportTransferRisks(): Promise<number> {
  const now = new Date();
  const alertDue = alertDueWhere(now);
  const atRisk = await prisma.recording.findMany({
    where: transferRiskWhere(now),
    select: {
      id: true,
      transferAttempts: true,
      transferFailureAlertedAt: true,
      streamUrlExpiresAt: true,
      lastTransferError: true,
      updatedAt: true,
    },
    orderBy: [
      { transferAttempts: "desc" },
      { streamUrlExpiresAt: "asc" },
      { id: "asc" },
    ],
    take: 100,
  });
  if (atRisk.length === 0) return 0;

  const claims = await mapBounded(atRisk, async (row) => {
    const claimed = await prisma.recording.updateMany({
      where: {
        id: row.id,
        status: RecordingStatus.READY,
        storageType: RecordingStorageType.STREAM_S3,
        streamUrlExpiresAt: { gt: now },
        updatedAt: row.updatedAt,
        ...alertDue,
      },
      // Alert bookkeeping must not postpone the copy's retry backoff.
      data: { transferFailureAlertedAt: now, updatedAt: row.updatedAt },
    });
    return claimed.count === 1 ? row : null;
  });
  const alerted = claims.filter((row) => row !== null);
  if (alerted.length === 0) return 0;

  reportSentryMessage(
    "Recording copies at risk: source expires within 72 hours or at least 3 attempts consumed",
    {
      subsystem: "stream",
      op: "transfer-recordings",
      level: "error",
      fingerprint: ["transfer-recordings", "source-expiry-risk"],
      extra: { recordings: alerted, sampleLimit: 100, cooldownHours: 6 },
    },
  );
  return alerted.filter((row) => row.transferAttempts >= MAX_TRANSFER_ATTEMPTS)
    .length;
}

/** A claim whose worker crashed: TRANSFERRING with no progress for the stale window. */
function staleTransferWhere(now: Date) {
  return {
    status: RecordingStatus.TRANSFERRING,
    storageType: RecordingStorageType.STREAM_S3,
    updatedAt: { lt: new Date(now.getTime() - STALE_TRANSFER_MS) },
  };
}

/** A live READY source whose retry backoff has elapsed. */
function copyCandidateWhere(now: Date): Prisma.RecordingWhereInput {
  return {
    status: RecordingStatus.READY,
    storageType: RecordingStorageType.STREAM_S3,
    transferAttempts: { lt: MAX_TRANSFER_ATTEMPTS },
    streamUrlExpiresAt: { gt: now },
    OR: retryEligibleWhere(now),
  };
}

/** Ticker idle probe: a stale claim, a copy candidate or a source due a risk alarm. */
export async function hasRecordingTransferWork(
  db: Db,
  now: Date,
): Promise<boolean> {
  const row = await db.recording.findFirst({
    where: {
      OR: [
        staleTransferWhere(now),
        copyCandidateWhere(now),
        transferRiskWhere(now),
      ],
    },
    select: { id: true },
  });
  return row !== null;
}

async function transferRecordingsUnlocked(): Promise<TransferRunResult> {
  const startedAt = Date.now();
  const result: TransferRunResult = {
    success: true,
    reclaimedStale: 0,
    processed: 0,
    succeeded: 0,
    failed: 0,
    exhaustedReported: 0,
    errors: [],
  };

  // A crashed run leaves its claim behind; its consumed attempt keeps R2 keys distinct.
  const staleWhere = staleTransferWhere(new Date(startedAt));
  const staleClaims = await prisma.recording.findMany({
    where: staleWhere,
    orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
    take: 1,
    select: { id: true, updatedAt: true },
  });
  const staleClaim = staleClaims[0];
  if (staleClaim) {
    const reclaimed = await prisma.recording.updateMany({
      where: {
        ...staleWhere,
        id: staleClaim.id,
        updatedAt: staleClaim.updatedAt,
      },
      // Preserve the claim time so reclamation does not restart retry backoff.
      data: { status: RecordingStatus.READY, updatedAt: staleClaim.updatedAt },
    });
    result.reclaimedStale = reclaimed.count;
  }

  const [candidate] = await prisma.recording.findMany({
    where: copyCandidateWhere(new Date()),
    orderBy: [{ streamUrlExpiresAt: "asc" }, { id: "asc" }],
    take: 1,
    select: { id: true },
  });
  if (candidate) {
    const outcome = await transferRecording(candidate.id);
    if (outcome.status !== "skipped") result.processed++;
    if (outcome.status === "copied") result.succeeded++;
    if (outcome.status === "failed") {
      result.failed++;
      result.errors.push(`Recording ${candidate.id}: ${outcome.error}`);
    }
  }

  result.exhaustedReported = await reportTransferRisks();
  result.success = result.failed === 0 && result.exhaustedReported === 0;
  streamLogger.info("transfer-recordings finished", {
    reclaimedStale: result.reclaimedStale,
    processed: result.processed,
    succeeded: result.succeeded,
    failed: result.failed,
    exhaustedReported: result.exhaustedReported,
  });
  return result;
}

/** Copy at most one retry-eligible recording, soonest-expiring first. */
export async function transferRecordings(): Promise<TransferRunResult> {
  return withCronLock(
    "transfer-recordings",
    { failMode: "closed", ttlMs: TRANSFER_LOCK_TTL_MS },
    transferRecordingsUnlocked,
  );
}
