/**
 * Reconciles recorded Stream sessions whose `call.recording_ready` webhook never persisted a `Recording` row.
 * Scans meetings aged 2h–14d via `RecordingService.syncSessionRecordings` for both zero-row and multi-segment sessions.
 */

import prisma from "../../lib/prisma";
import { readJobCheckpoint, withCronLock } from "@/lib/cron/with-cron-lock";
import { RecordingService } from "@/lib/stream/recording-service";
import { isStreamConfigured } from "@/lib/stream-client";
import type { RecordingRow } from "@/lib/stream/recording-types";

export interface OrphanedRecordingResult {
  /** Sessions that claim a recording and have no `Recording` row. */
  scanned: number;
  /** `Recording` rows created from what Stream actually held. */
  recovered: number;
  /** Sessions Stream had nothing for — the file is gone, or never existed. */
  stillMissing: number;
  /** Sessions already past Stream's retention, reported and not retried. */
  unrecoverable: number;
  /**
   * Sessions that already had at least one `Recording` and were re-examined
   * anyway, because having SOME recordings does not mean having ALL of them.
   */
  partialScanned: number;
  /** Rows created by that second pass — segments an earlier run never saw. */
  partialRecovered: number;
  success: boolean;
  errors: string[];
  checkpoint: string | null;
  hasMore: boolean;
}

/**
 * Stream deletes a recording fourteen days after the call. Looking further back
 * than that only produces `listRecordings` calls that can never return
 * anything, so the window is the retention period itself. Anything older is
 * counted as unrecoverable and reported rather than retried forever.
 */
const STREAM_RETENTION_DAYS = 14;

/**
 * How long to let the normal path finish before treating a session as orphaned.
 *
 * `call.recording_ready` is not immediate — Stream has to finish the egress and
 * upload the file, which takes minutes for a long session. Sweeping too early
 * would race the webhook and issue a `listRecordings` for a file that is still
 * being written, so this is generous: a recording that has not arrived two
 * hours after the call is not late, it is lost.
 */
const MIN_AGE_HOURS = 2;

/** Bounded per run so one backlog cannot hold the workflow open. */
const MAX_SESSIONS_PER_RUN = 25;
const START_BUDGET_MS = 5 * 60 * 1000;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * The appointment shape `syncSessionRecordings` needs to title a recording and
 * to mirror the parent's org tag. Identical to the consultant sync path's
 * include, and it has to be: the two produce the same rows.
 */
const orphanedSessionInclude = {
  occurrence: {
    include: {
      appointment: {
        include: {
          consultation: { include: { consultationPlan: true } },
          subscription: { include: { subscriptionPlan: true } },
          trial: { include: { subscriptionPlan: true } },
          webinar: { include: { webinarPlan: true } },
          class: { include: { classPlan: true } },
        },
      },
    },
  },
} as const;

export async function reconcileOrphanedRecordings(): Promise<OrphanedRecordingResult> {
  // A failed lease acquisition must never admit a concurrent vendor sweep.
  return withCronLock(
    "reconcile-orphaned-recordings",
    { failMode: "closed" },
    () => reconcileOrphanedRecordingsUnlocked(),
  );
}

async function reconcileOrphanedRecordingsUnlocked(): Promise<OrphanedRecordingResult> {
  const result: OrphanedRecordingResult = {
    scanned: 0,
    recovered: 0,
    stillMissing: 0,
    unrecoverable: 0,
    partialScanned: 0,
    partialRecovered: 0,
    success: true,
    errors: [],
    checkpoint: await readJobCheckpoint("reconcile-orphaned-recordings"),
    hasMore: false,
  };

  if (!isStreamConfigured()) {
    // Not a quiet success. This job's entire purpose is to notice that
    // recordings are not arriving, and a run that could not ask Stream has
    // noticed nothing — reporting green would reproduce the failure mode.
    result.errors.push("Stream is not configured — cannot reconcile");
    result.success = false;
    return result;
  }

  const now = Date.now();
  const notBefore = new Date(now - STREAM_RETENTION_DAYS * DAY_MS);
  const notAfter = new Date(now - MIN_AGE_HOURS * HOUR_MS);

  const eligible = {
    recordingStartedAt: { gte: notBefore, lt: notAfter },
    streamCallId: { not: "" },
  };
  const readPage = (after: string | null) =>
    prisma.meeting.findMany({
      where: { ...eligible, ...(after ? { id: { gt: after } } : {}) },
      orderBy: { id: "asc" },
      take: MAX_SESSIONS_PER_RUN,
      include: {
        ...orphanedSessionInclude,
        recordings: { select: { id: true }, take: 1 },
      },
    });
  let sessions = await readPage(result.checkpoint);
  if (sessions.length === 0 && result.checkpoint) {
    result.checkpoint = null;
    sessions = await readPage(null);
  }
  result.unrecoverable = await prisma.meeting.count({
    where: {
      recordingStartedAt: { lt: notBefore },
      streamCallId: { not: "" },
      recordings: { none: {} },
    },
  });
  const deadline = now + START_BUDGET_MS;
  for (const session of sessions) {
    if (Date.now() >= deadline) {
      result.hasMore = true;
      break;
    }
    const partial = session.recordings.length > 0;
    if (partial) result.partialScanned++;
    else result.scanned++;
    const recovered: RecordingRow[] = [];
    try {
      const outcome = await RecordingService.syncSessionRecordings(
        session,
        recovered,
        { notify: true },
      );
      if (!outcome.ok) throw new Error(`sync failed (${outcome.reason})`);
      if (partial) result.partialRecovered += recovered.length;
      else {
        result.recovered += recovered.length;
        if (!recovered.length) result.stillMissing++;
      }
    } catch (error) {
      result.success = false;
      result.errors.push(
        `session ${session.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    // Rotate even failures and empty sources so they cannot pin the partial-delivery tail.
    result.checkpoint = session.id;
  }
  result.hasMore ||= sessions.length === MAX_SESSIONS_PER_RUN;
  return result;
}
