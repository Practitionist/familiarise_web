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
 * Schedule: daily at 03:00 UTC (avoids the 02:00 abandoned-top-ups
 * slot + the 02:30 reconcile-ledgers slot — Prisma connection pool
 * contention).
 */

import prisma from "../../lib/prisma";
import { AUDIT_ACTIONS } from "../../lib/enterprise/audit-actions";

export interface StreamRetentionResult {
  scanned: number;
  expired: number;
  cutoffsByOrg: Array<{ organizationId: string; retentionDays: number; expiredCount: number }>;
  success: boolean;
  errors: string[];
}

export async function cleanupOldStreamRecordings(): Promise<StreamRetentionResult> {
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

    const candidates = await prisma.recording.findMany({
      where: {
        organizationId: org.id,
        createdAt: { lt: cutoff },
        status: { notIn: ["EXPIRED", "FAILED"] },
      },
      select: { id: true },
    });
    result.scanned += candidates.length;
    if (candidates.length === 0) {
      result.cutoffsByOrg.push({
        organizationId: org.id,
        retentionDays: org.streamRecordingRetentionDays,
        expiredCount: 0,
      });
      continue;
    }

    try {
      await prisma.$transaction(async (tx) => {
        await tx.recording.updateMany({
          where: { id: { in: candidates.map((c) => c.id) } },
          data: { status: "EXPIRED" },
        });
        await tx.orgAuditLog.create({
          data: {
            organizationId: org.id,
            category: "SYSTEM",
            action: AUDIT_ACTIONS.SYSTEM.STREAM_RECORDING_DELETED,
            description: `Tombstoned ${candidates.length} recording(s) past ${org.streamRecordingRetentionDays}d retention`,
            details: {
              cutoff: cutoff.toISOString(),
              retentionDays: org.streamRecordingRetentionDays,
              count: candidates.length,
            },
          },
        });
      });
      result.expired += candidates.length;
      result.cutoffsByOrg.push({
        organizationId: org.id,
        retentionDays: org.streamRecordingRetentionDays,
        expiredCount: candidates.length,
      });
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
