/**
 * Stream Recording Retention Cron — Core Logic
 *
 * Tombstones recordings whose age exceeds the owning org's
 * `Organization.streamRecordingRetentionDays` (default 90). The
 * recording row stays in the DB (audit + financial-linkage continuity)
 * but its status flips to `EXPIRED` and the Stream S3 URL is no
 * longer surfaced through the dashboard.
 *
 * We DON'T call the Stream API to delete the underlying object —
 * Stream's S3 storage has its own 2-week expiry on the free tier, and
 * the paid tier's lifecycle policies are configured per-channel, not
 * per-recording. The local tombstone is what makes the dashboard
 * stop offering the URL; the underlying S3 object is Stream's problem.
 *
 * Supabase objects ARE ours, though (#899): recordings already moved to
 * the permanent bucket get their object deleted before the tombstone,
 * otherwise the bytes outlive the retention window (DPDP gap).
 *
 * Schedule: daily at 03:00 UTC (avoids the 02:00 abandoned-top-ups
 * slot + the 02:30 reconcile-ledgers slot — Prisma connection pool
 * contention).
 */

import prisma from "../../lib/prisma";
import { AUDIT_ACTIONS } from "../../lib/enterprise/audit-actions";
import { withCronLock } from "@/lib/cron/with-cron-lock";
import { deleteRecordingObject } from "@/lib/stream/recording-storage";

export interface StreamRetentionResult {
  scanned: number;
  expired: number;
  cutoffsByOrg: Array<{
    organizationId: string;
    retentionDays: number;
    expiredCount: number;
  }>;
  success: boolean;
  errors: string[];
}

type OrgRetention = { id: string; streamRecordingRetentionDays: number };
type RecordingCandidate = { id: string; storagePath: string | null };

function recordOrgOutcome(
  result: StreamRetentionResult,
  org: OrgRetention,
  expiredCount: number,
): void {
  result.cutoffsByOrg.push({
    organizationId: org.id,
    retentionDays: org.streamRecordingRetentionDays,
    expiredCount,
  });
}

/**
 * Which candidates are ready to tombstone, split by what this run knows about
 * their bytes. The split is what makes the flip fenceable — see
 * `tombstoneRecordings`.
 */
type TombstonePlan = {
  /** Candidates that had no object — safe to tombstone while the path is still null. */
  withoutObject: RecordingCandidate[];
  /** Candidates whose object we just deleted — safe only while the row still names it. */
  withObject: RecordingCandidate[];
};

/**
 * #899 — resolve which candidates are ready to tombstone. Rows without a
 * Supabase object tombstone directly. Rows with one must have their storage
 * object deleted first (DPDP) — an EXPIRED row with bytes still in the bucket is
 * orphaned storage and a retention violation. The network-bound deletes run in
 * bounded chunks (mirroring processExpiringRecordings' transfer sweep) so a large
 * candidate set can't serialise into a timeout or exhaust the pool. A failed
 * delete keeps its row un-tombstoned so tomorrow's run retries the pair together.
 */
async function collectTombstonePlan(
  org: OrgRetention,
  candidates: RecordingCandidate[],
  result: StreamRetentionResult,
): Promise<TombstonePlan> {
  const plan: TombstonePlan = { withoutObject: [], withObject: [] };

  // Rows without a Supabase object need no storage call — tombstone directly.
  for (const candidate of candidates) {
    if (!candidate.storagePath) {
      plan.withoutObject.push(candidate);
    }
  }

  const supabaseCandidates = candidates.filter((c) => c.storagePath);
  const CONCURRENCY = 5;
  for (let i = 0; i < supabaseCandidates.length; i += CONCURRENCY) {
    const chunk = supabaseCandidates.slice(i, i + CONCURRENCY);
    await Promise.all(
      chunk.map(async (candidate) => {
        // #899 — delete only the storage object here; the row's status flip
        // + audit log land together in the transaction below so a partial
        // failure can't tombstone the row before the audit write (which the
        // `notIn [EXPIRED]` candidate filter would then never retry).
        const del = await deleteRecordingObject(candidate.storagePath!);
        if (del.success) {
          plan.withObject.push(candidate);
        } else {
          result.success = false;
          result.errors.push(
            `org=${org.id} recording=${candidate.id}: ${del.error}`,
          );
        }
      }),
    );
  }

  return plan;
}

// Tombstone + clear the now-deleted Supabase pointers atomically with the audit
// log (the storage object was removed above). storageType reflects that only
// Stream's S3 copy — if any — remains.
//
// D1 — this is the third writer in the race, and it was the one with the worst
// outcome. It used to be `updateMany where { id: { in: ids } }` with no fence,
// and the candidate list it acts on was read BEFORE the storage deletes above, so
// the window between scan and flip is the whole delete loop — seconds to minutes,
// inside a 10-minute workflow budget. Two ways that went wrong:
//
//   (a) A row with a null storagePath was tombstoned while a transfer was in
//       flight. The transfer then completed and, unfenced, wrote
//       storagePath + PLATFORM + AVAILABLE — resurrecting a row past its
//       retention window, pointing at bytes the retention sweep had never
//       deleted (it only ever deletes the object named by storagePath). Those
//       bytes then outlived the org's window, which is a DPDP violation, and
//       the row became permanently invisible to this sweep's own
//       `notIn [EXPIRED, FAILED]` candidate filter, so nothing would ever
//       reclaim it. The counterpart of that is now fenced on the transfer's side
//       (recording-transfer-service fences BOTH its writes); this fence closes
//       the other direction.
//
//   (b) A row whose transfer completed between the scan and the flip still has
//       `status: notIn [EXPIRED, FAILED]` and gets tombstoned — with an object
//       in the bucket that nothing will delete, because this run already decided
//       (from the stale null path) that there was nothing to delete.
//
// So each flip is fenced on exactly what this run observed: the no-object group
// on `storagePath: null`, the had-object group on the specific path whose object
// was just deleted. A row that moved under us simply does not match, is not
// counted, and is picked up by the next run against its new state. Counting only
// real flips is what keeps `result.expired` and the audit's `count` honest.
async function tombstoneRecordings(
  org: OrgRetention,
  plan: TombstonePlan,
  cutoff: Date,
): Promise<number> {
  return prisma.$transaction(async (tx) => {
    let tombstoned = 0;

    if (plan.withoutObject.length > 0) {
      tombstoned += (
        await tx.recording.updateMany({
          where: {
            OR: plan.withoutObject.map((c) => ({
              id: c.id,
              storagePath: null,
            })),
            status: { notIn: ["EXPIRED", "FAILED"] },
          },
          data: {
            status: "EXPIRED",
            storageUrl: null,
            storagePath: null,
            storageType: "STREAM_S3",
          },
        })
      ).count;
    }

    if (plan.withObject.length > 0) {
      tombstoned += (
        await tx.recording.updateMany({
          where: {
            OR: plan.withObject.map((c) => ({
              id: c.id,
              storagePath: c.storagePath!,
            })),
            status: { notIn: ["EXPIRED", "FAILED"] },
          },
          data: {
            status: "EXPIRED",
            storageUrl: null,
            storagePath: null,
            storageType: "STREAM_S3",
          },
        })
      ).count;
    }

    if (tombstoned === 0) {
      // Every candidate lost its race. Writing an audit row for zero deletions
      // would be a trail that claims work that did not happen.
      return 0;
    }

    await tx.orgAuditLog.create({
      data: {
        organizationId: org.id,
        category: "SYSTEM",
        action: AUDIT_ACTIONS.SYSTEM.STREAM_RECORDING_DELETED,
        description: `Tombstoned ${tombstoned} recording(s) past ${org.streamRecordingRetentionDays}d retention`,
        details: {
          cutoff: cutoff.toISOString(),
          retentionDays: org.streamRecordingRetentionDays,
          count: tombstoned,
        },
      },
    });

    return tombstoned;
  });
}

/**
 * #476 — locked at the core so every entry (GH Actions / HTTP) shares one
 * mutual exclusion; fail-open: repeat-safe side effects, lock is belt-and-braces.
 */
export async function cleanupOldStreamRecordings(): Promise<StreamRetentionResult> {
  return withCronLock(
    "cleanup-old-stream-recordings",
    { failMode: "open" },
    () => cleanupOldStreamRecordingsUnlocked(),
  );
}

/**
 * D7 — how many candidates one org may contribute per run, and how many rows a
 * single page holds.
 *
 * The candidate query used to have neither a `take` nor a cursor, and the
 * per-org loop then walked the whole result set through the storage-delete
 * chunks (CONCURRENCY 5) before writing a single tombstone. One org with a few
 * thousand stale recordings therefore consumed the entire 10-minute workflow
 * budget inside the delete loop and was killed mid-pass — which is the worst
 * place to be killed, because the storage objects for the rows already handled
 * are gone while their rows are still READY. Tomorrow's run would re-scan them,
 * find a `storagePath` whose object no longer exists, and call `remove` on it
 * (a no-op that reports success), so it happened to converge — but only by
 * accident, and with a full day of latency per attempt.
 *
 * Paging fixes the memory shape and `PER_ORG_PAGE_CAP` bounds the time. The
 * cap is deliberately not a silent truncation: `result.errors` records that the
 * org still has candidates, so an org permanently over the cap is visible
 * rather than quietly retried forever at the same ceiling.
 */
const CANDIDATE_PAGE_SIZE = 200;
const PER_ORG_PAGE_CAP = 5;
const PER_ORG_CANDIDATE_CAP = CANDIDATE_PAGE_SIZE * PER_ORG_PAGE_CAP;

async function cleanupOldStreamRecordingsUnlocked(): Promise<StreamRetentionResult> {
  const result: StreamRetentionResult = {
    scanned: 0,
    expired: 0,
    cutoffsByOrg: [],
    success: true,
    errors: [],
  };

  // Per-org pass — each org may have its own retention window. We
  // accept the N+1 cost (org count is small, recording volume is
  // moderate) because a single global query would force a CASE WHEN
  // join on `organizations.streamRecordingRetentionDays` that the
  // Prisma client can't express.
  const orgs = await prisma.organization.findMany({
    select: { id: true, streamRecordingRetentionDays: true },
    where: {
      // Only orgs that actually have recordings — skip the org table
      // entries with zero footprint.
      recordingsByOrg: { some: {} },
    },
  });

  const now = Date.now();
  for (const org of orgs) {
    const retentionMs = org.streamRecordingRetentionDays * 24 * 60 * 60 * 1000;
    const cutoff = new Date(now - retentionMs);

    // Keyset pagination on `createdAt` (indexed, and the column the retention
    // window is expressed in) with `id` as the tie-breaker. `skip` would be
    // wrong here: rows tombstoned by a previous page leave the `notIn` filter
    // while this run is still walking, so an offset cursor would skip rows.
    const candidates: RecordingCandidate[] = [];
    let cursor: { createdAt: Date; id: string } | null = null;

    for (let page = 0; page < PER_ORG_PAGE_CAP; page++) {
      const batch: (RecordingCandidate & { createdAt: Date })[] =
        await prisma.recording.findMany({
          where: {
            organizationId: org.id,
            createdAt: { lt: cutoff },
            status: { notIn: ["EXPIRED", "FAILED"] },
            ...(cursor
              ? {
                  OR: [
                    { createdAt: { gt: cursor.createdAt } },
                    { createdAt: cursor.createdAt, id: { gt: cursor.id } },
                  ],
                }
              : {}),
          },
          select: { id: true, storagePath: true, createdAt: true },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          take: CANDIDATE_PAGE_SIZE,
        });

      candidates.push(...batch);
      if (batch.length < CANDIDATE_PAGE_SIZE) break;
      const last = batch[batch.length - 1];
      cursor = { createdAt: last.createdAt, id: last.id };
    }

    if (candidates.length >= PER_ORG_CANDIDATE_CAP) {
      // Reported, never silent: an org that can never drain under the cap needs
      // a human to raise it, and "0 expired" would otherwise read as healthy.
      result.success = false;
      result.errors.push(
        `org=${org.id}: ${PER_ORG_CANDIDATE_CAP}+ recordings past retention — raise PER_ORG_PAGE_CAP or the window is not being worked off`,
      );
    }

    result.scanned += candidates.length;
    if (candidates.length === 0) {
      recordOrgOutcome(result, org, 0);
      continue;
    }

    // DPDP (#899) — purge the Supabase object before tombstoning the row.
    const plan = await collectTombstonePlan(org, candidates, result);
    if (plan.withoutObject.length === 0 && plan.withObject.length === 0) {
      recordOrgOutcome(result, org, 0);
      continue;
    }

    try {
      const tombstoned = await tombstoneRecordings(org, plan, cutoff);
      result.expired += tombstoned;
      recordOrgOutcome(result, org, tombstoned);
    } catch (err) {
      result.success = false;
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`org=${org.id}: ${msg}`);
    }
  }

  return result;
}

export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}
