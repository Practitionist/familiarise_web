/**
 * Owns each immutable export object until confirmed removal. Only the current
 * status/startedAt attempt may publish or fail its job.
 */

import prisma from "../../lib/prisma";
import type { PrismaLike } from "@/lib/prisma";
import { AUDIT_ACTIONS } from "../../lib/enterprise/audit-actions";
import { recordSystemError } from "../../lib/enterprise/system-events";
import { checkConsentBatch } from "../../lib/compliance/dpdp";
import { PURPOSE_CODES } from "../../lib/compliance/purpose-codes";
import { notifyOrgDataExportReady } from "../../lib/novu/org-workflows";
import { getAppUrl } from "../../lib/url";
import { stageOrgOperationalEmail } from "../../lib/email/senders/money";
import { attemptStaged } from "../../lib/email/send-to-recipients";
import { EMAIL_BUDGET_MS } from "../../lib/email/config";
import { attemptTrigger } from "../../lib/novu/outbox";
import { adminStorage, removeObjects } from "../../lib/supabase-storage-core";
import { withCronLock, LONG_JOB_TTL_MS } from "@/lib/cron/with-cron-lock";
import { startDeadline } from "@/lib/cron/run-deadline";
import type { OrgDataExportKind, Prisma } from "@prisma/client";
import { z } from "zod";
import {
  bundleKinds,
  canHandleExportKind,
  type DataExportKind,
} from "@/lib/enterprise/data-export-kinds";

const missingExportObjectSchema = z.object({ code: z.literal("NoSuchKey") });

export interface DataExportResult {
  picked: number;
  succeeded: number;
  failed: number;
  superseded: number;
  expired: number;
  expiryFailed: number;
  success: boolean;
  errors: string[];
}

/**
 * The bundle structure is intentionally flat — one top-level key per
 * entity — so an integrator's parser doesn't have to know the
 * relational graph to extract anything useful.
 */
interface ExportBundle {
  organizationId: string;
  generatedAt: string;
  schemaVersion: 1;
  /** #1527 — which kinds this bundle carries; the other kind's keys are absent. */
  kinds: DataExportKind[];
  organization: unknown;
  members?: unknown[];
  memberships?: unknown[];
  contracts?: unknown[];
  programs?: unknown[];
  invoices?: unknown[];
  earnings?: unknown[];
  payouts?: unknown[];
  auditLog?: unknown[];
  /** #701 — count of members whose PII was withheld for lack of consent. */
  excludedForConsent?: number;
}

/**
 * #1527 decision 4 — the bundle carries only the requested kind: people
 * (members, memberships, audit log, consent-withheld count) or finance
 * (contracts, programs, invoices, earnings, payouts). A pre-split FULL job
 * builds both, as before.
 */
async function buildBundleFor(
  organizationId: string,
  kind: OrgDataExportKind,
): Promise<ExportBundle> {
  const kinds = bundleKinds(kind);
  const full = await buildFullBundleFor(organizationId);
  const people = kinds.includes("PEOPLE");
  const finance = kinds.includes("FINANCE");
  return {
    organizationId: full.organizationId,
    generatedAt: full.generatedAt,
    schemaVersion: full.schemaVersion,
    kinds,
    organization: full.organization,
    ...(people && {
      members: full.members,
      memberships: full.memberships,
      auditLog: full.auditLog,
      excludedForConsent: full.excludedForConsent,
    }),
    ...(finance && {
      contracts: full.contracts,
      programs: full.programs,
      invoices: full.invoices,
      earnings: full.earnings,
      payouts: full.payouts,
    }),
  };
}

/**
 * Whether the requester may still receive this kind — re-checked at build
 * time so a role change between request and build can't widen the bundle.
 */
async function requesterMayExport(
  requestedByMembershipId: string,
  kind: OrgDataExportKind,
): Promise<boolean> {
  const requester = await prisma.membership.findUnique({
    where: { id: requestedByMembershipId },
    select: { status: true, role: true },
  });
  return (
    requester?.status === "ACTIVE" && canHandleExportKind(requester.role, kind)
  );
}

async function buildFullBundleFor(
  organizationId: string,
): Promise<Omit<Required<ExportBundle>, "kinds">> {
  // Each query is small + indexed (organizationId is on every relevant
  // table). The 8-entity walk is a few hundred KB even for established
  // orgs; we don't paginate because the export caller wants
  // single-snapshot atomicity.
  const [
    organization,
    memberships,
    contracts,
    programs,
    invoices,
    earnings,
    payouts,
    auditLog,
  ] = await prisma.$transaction([
    prisma.organization.findUnique({ where: { id: organizationId } }),
    prisma.membership.findMany({
      where: { organizationId },
      include: { user: { select: { id: true, name: true, email: true } } },
    }),
    prisma.contract.findMany({ where: { organizationId } }),
    // Why the indirect filter on Program: it carries no direct
    // organizationId column — programs hang off `Contract`, which is
    // the FK that holds the org link. Use the relation-filter so
    // Prisma emits a single EXISTS subquery instead of a join.
    prisma.program.findMany({
      where: { contract: { organizationId } },
    }),
    prisma.organizationInvoice.findMany({ where: { organizationId } }),
    prisma.organizationEarnings.findMany({ where: { organizationId } }),
    prisma.organizationPayout.findMany({ where: { organizationId } }),
    // Audit log: respect the 2y retention floor for non-financial rows
    // and 7y for financial. The prune cron already enforces this, but
    // the explicit `findMany` without filter is the right snapshot —
    // whatever survived retention IS what the export gets.
    prisma.orgAuditLog.findMany({
      where: { organizationId },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  const seenUserIds = new Set<string>();
  const allMembers = memberships
    .map((m) => m.user)
    .filter((u) => {
      if (!u || seenUserIds.has(u.id)) return false;
      seenUserIds.add(u.id);
      return true;
    });

  // #701 — DPDP: withhold PII for members who have withdrawn core-processing
  // consent. Their name/email are dropped from `members` and scrubbed from the
  // membership rows (the org-relationship metadata stays). TODO(#701): extend to
  // field-level scoping across the rest of the bundle.
  // #1019 — one batch query instead of a per-member loop (pool-safe for large
  // orgs). consentedIds holds the members who HAVE core-processing consent.
  const consentedIds = await checkConsentBatch({
    userIds: allMembers.map((u) => u.id),
    purposeCode: PURPOSE_CODES.PRIMARY_PROCESSING,
  });
  const members = allMembers.filter((u) => consentedIds.has(u.id));
  const excludedForConsent = allMembers.length - members.length;
  const scrubbedMemberships = memberships.map((m) =>
    m.user && !consentedIds.has(m.user.id)
      ? { ...m, user: { id: m.user.id, name: null, email: null } }
      : m,
  );

  return {
    organizationId,
    generatedAt: new Date().toISOString(),
    schemaVersion: 1,
    organization,
    members,
    memberships: scrubbedMemberships,
    contracts,
    programs,
    invoices,
    earnings,
    payouts,
    auditLog,
    excludedForConsent,
  };
}

async function uploadBundle(
  bucket: string,
  storagePath: string,
  bundle: ExportBundle,
): Promise<number> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseServiceKey) {
    throw new Error("Data export storage is not configured");
  }

  const json = JSON.stringify(bundle, null, 2);
  const sizeBytes = Buffer.byteLength(json, "utf8");
  const { createClient } = await import("@supabase/supabase-js");
  const supabase = createClient(supabaseUrl, supabaseServiceKey);
  const { error: uploadErr } = await supabase.storage
    .from(bucket)
    .upload(storagePath, json, {
      contentType: "application/json",
      upsert: false,
    });
  if (uploadErr) {
    throw new Error(`Supabase upload failed: ${uploadErr.message}`);
  }
  return sizeBytes;
}

/** Pending jobs and PROCESSING jobs whose attempt started before `staleBefore`. */
function claimableExportWhere(
  staleBefore: Date,
): Prisma.OrgDataExportJobWhereInput {
  return {
    OR: [
      { status: "PENDING" },
      {
        status: "PROCESSING",
        OR: [{ startedAt: null }, { startedAt: { lte: staleBefore } }],
      },
    ],
  };
}

function expiredArtifactWhere(
  now: Date,
): Prisma.OrgDataExportArtifactWhereInput {
  return { expiresAt: { lte: now } };
}

/** Ticker idle probe: an expired artifact or a claimable export job. */
export async function hasDataExportWork(
  db: PrismaLike,
  now: Date,
  outOfTime: () => boolean,
): Promise<boolean> {
  if (outOfTime()) return true;
  const artifact = await db.orgDataExportArtifact.findFirst({
    where: expiredArtifactWhere(now),
    select: { exportJobId: true },
  });
  if (artifact) return true;
  if (outOfTime()) return true;
  const job = await db.orgDataExportJob.findFirst({
    where: claimableExportWhere(new Date(now.getTime() - LONG_JOB_TTL_MS)),
    select: { id: true },
  });
  return job !== null;
}

// The shared lock is fail-closed because duplicate export builds consume data,
// storage, and notification work even though the attempt CAS remains safe.
export async function processDataExports(): Promise<DataExportResult> {
  return withCronLock(
    "process-data-exports",
    { failMode: "closed", ttlMs: LONG_JOB_TTL_MS },
    () => processDataExportsUnlocked(),
  );
}

async function processDataExportsUnlocked(): Promise<DataExportResult> {
  const result: DataExportResult = {
    picked: 0,
    succeeded: 0,
    failed: 0,
    superseded: 0,
    expired: 0,
    expiryFailed: 0,
    success: true,
    errors: [],
  };
  const pastDeadline = startDeadline();
  await expireExportArtifacts(result, pastDeadline);
  if (pastDeadline()) return result;

  const staleBefore = new Date(Date.now() - LONG_JOB_TTL_MS);
  const job = await prisma.orgDataExportJob.findFirst({
    where: claimableExportWhere(staleBefore),
    orderBy: { createdAt: "asc" },
  });
  if (!job) return result;
  result.picked = 1;
  if (pastDeadline()) {
    result.picked = 0;
    return result;
  }

  const priorStartedAt = job.startedAt;
  const claimAt = new Date(
    Math.max(Date.now(), (priorStartedAt?.getTime() ?? 0) + 1),
  );
  const bucket = process.env.SUPABASE_DATA_EXPORT_BUCKET ?? "org-exports";
  const storagePath = `${job.organizationId}/${job.id}/${claimAt.getTime()}.json`;
  const artifactExpiry = new Date(claimAt.getTime() + 7 * 24 * 60 * 60 * 1000);
  const claimed = await prisma.$transaction(async (tx) => {
    const changed = await tx.orgDataExportJob.updateMany({
      where: {
        id: job.id,
        status: job.status,
        startedAt: priorStartedAt,
      },
      data: { status: "PROCESSING", startedAt: claimAt, error: null },
    });
    if (changed.count !== 1) return false;
    await tx.orgDataExportArtifact.create({
      data: {
        exportJobId: job.id,
        attemptStartedAt: claimAt,
        bucket,
        storagePath,
        expiresAt: artifactExpiry,
      },
    });
    return true;
  });
  if (!claimed) {
    result.picked = 0;
    result.superseded = 1;
    return result;
  }

  try {
    if (!(await requesterMayExport(job.requestedByMembershipId, job.kind))) {
      throw new ExportFailure(
        "The member who requested this export no longer has access to it.",
        "The requester no longer has the grant for this export.",
      );
    }
    const bundle = await buildBundleFor(job.organizationId, job.kind);
    const sizeBytes = await uploadBundle(bucket, storagePath, bundle);
    const completedAt = new Date();
    const expiresAt = new Date(completedAt.getTime() + 7 * 24 * 60 * 60 * 1000);
    const staged = await prisma.$transaction(async (tx) => {
      const changed = await tx.orgDataExportJob.updateMany({
        where: { id: job.id, status: "PROCESSING", startedAt: claimAt },
        data: {
          status: "READY",
          fileUrl: null,
          fileSizeBytes: BigInt(sizeBytes),
          expiresAt,
          completedAt,
          error: null,
        },
      });
      if (changed.count !== 1) return null;
      const ownerChanged = await tx.orgDataExportArtifact.updateMany({
        where: { exportJobId: job.id, attemptStartedAt: claimAt },
        data: { expiresAt, fileSizeBytes: BigInt(sizeBytes) },
      });
      if (ownerChanged.count !== 1) {
        throw new Error("Export artifact owner row missing during publication");
      }
      await tx.orgAuditLog.create({
        data: {
          organizationId: job.organizationId,
          category: "SYSTEM",
          action: AUDIT_ACTIONS.SYSTEM.DATA_EXPORT_GENERATED,
          description: `Generated data export bundle (${sizeBytes} bytes)`,
          details: {
            exportId: job.id,
            fileSizeBytes: sizeBytes,
            expiresAt: expiresAt.toISOString(),
          },
        },
      });
      const [orgRow, requesterMembership, ownerRows] = await Promise.all([
        tx.organization.findUnique({
          where: { id: job.organizationId },
          select: { name: true },
        }),
        tx.membership.findUnique({
          where: { id: job.requestedByMembershipId },
          select: { userId: true },
        }),
        tx.membership.findMany({
          where: {
            organizationId: job.organizationId,
            role: "OWNER",
            status: "ACTIVE",
          },
          select: { userId: true },
        }),
      ]);
      const recipientUserIds = Array.from(
        new Set([
          ...ownerRows.map((o) => o.userId),
          ...(requesterMembership?.userId ? [requesterMembership.userId] : []),
        ]),
      );
      const dashboardUrl = `${getAppUrl()}/dashboard/organization/${job.organizationId}/settings/data-exports`;
      const emailRows = orgRow
        ? await stageOrgOperationalEmail(tx, {
            recipientUserIds,
            organizationId: job.organizationId,
            orgName: orgRow.name,
            kind: "DATA_EXPORT_READY",
            expiresAt,
            actionUrl: dashboardUrl,
            entityRef: `export:${job.id}`,
          })
        : [];
      const notificationRows = orgRow
        ? await notifyOrgDataExportReady(
            job.organizationId,
            {
              orgName: orgRow.name,
              exportId: job.id,
              fileSizeBytes: sizeBytes,
              expiresAt: expiresAt.toISOString(),
              downloadUrl: dashboardUrl,
              dashboardUrl,
            },
            {
              tx,
              deferAttempt: true,
              entityRef: `export:${job.id}`,
              dedupeKey: `data-export-ready:${job.id}`,
            },
          )
        : [];
      return { emailRows, notificationRows };
    });

    if (!staged) {
      result.superseded = 1;
      return result;
    }
    await attemptStaged(
      staged.emailRows,
      "ORG_DATA_EXPORT_READY",
      EMAIL_BUDGET_MS.JOB,
    ).catch(() =>
      console.error(
        `[process-data-exports] email attempt failed for ${job.id}`,
      ),
    );
    for (const row of staged.notificationRows) {
      await attemptTrigger(row).catch(() =>
        console.error(
          `[process-data-exports] notification attempt failed for ${job.id}`,
        ),
      );
    }

    result.succeeded = 1;
  } catch (err) {
    const failure =
      err instanceof ExportFailure
        ? err
        : new ExportFailure(
            "The data export could not be generated. Please retry or contact support.",
            "Data export bundle failed",
          );
    const completedAt = new Date();
    const failed = await prisma.$transaction(async (tx) => {
      const changed = await tx.orgDataExportJob.updateMany({
        where: { id: job.id, status: "PROCESSING", startedAt: claimAt },
        data: {
          status: "FAILED",
          error: failure.safeMessage,
          completedAt,
        },
      });
      if (changed.count !== 1) return false;
      await tx.orgAuditLog.create({
        data: {
          organizationId: job.organizationId,
          category: "SYSTEM",
          action: AUDIT_ACTIONS.SYSTEM.DATA_EXPORT_FAILED,
          description:
            "Data export bundle could not be generated. Our engineering team has been notified — please retry or contact support if the issue persists.",
          // `details` stays minimal + org-safe: the export ID lets the
          // OWNER reference the failed request when contacting support,
          // but no error payload leaks here.
          details: { exportId: job.id },
        },
      });
      return true;
    });
    if (!failed) {
      result.superseded = 1;
      return result;
    }
    result.failed = 1;
    result.success = false;
    result.errors.push(`job=${job.id}: ${failure.safeMessage}`);
    await recordSystemError({
      organizationId: job.organizationId,
      category: "DATA_EXPORT",
      summary: failure.systemSummary,
      err,
      context: { exportId: job.id },
      correlationId: job.id,
    });
  }

  return result;
}

class ExportFailure extends Error {
  constructor(
    readonly safeMessage: string,
    readonly systemSummary: string,
  ) {
    super(systemSummary);
  }
}

async function expireExportArtifacts(
  result: DataExportResult,
  pastDeadline: () => boolean,
): Promise<void> {
  const now = new Date();
  const due = await prisma.orgDataExportArtifact.findMany({
    where: expiredArtifactWhere(now),
    orderBy: [
      { lastDeleteAttemptedAt: { sort: "asc", nulls: "first" } },
      { expiresAt: "asc" },
      { createdAt: "asc" },
      { exportJobId: "asc" },
    ],
    take: 10,
  });
  for (const artifact of due) {
    if (pastDeadline()) break;
    const activeAttempt = await prisma.orgDataExportJob.findFirst({
      where: {
        id: artifact.exportJobId,
        status: "PROCESSING",
        startedAt: artifact.attemptStartedAt,
      },
      select: { id: true },
    });
    if (activeAttempt) continue;
    const claimed = await prisma.orgDataExportArtifact.updateMany({
      where: {
        exportJobId: artifact.exportJobId,
        attemptStartedAt: artifact.attemptStartedAt,
        lastDeleteAttemptedAt: artifact.lastDeleteAttemptedAt,
        expiresAt: { lte: now },
      },
      data: { lastDeleteAttemptedAt: now },
    });
    if (claimed.count !== 1) continue;
    const removed = await removeObjects(artifact.bucket, [
      artifact.storagePath,
    ]);
    if (!removed) {
      recordExpiryFailure(result, artifact.exportJobId);
      continue;
    }
    try {
      const { data: metadata, error } = await adminStorage()
        .from(artifact.bucket)
        .info(artifact.storagePath);
      if (
        metadata !== null ||
        !missingExportObjectSchema.safeParse(error).success
      ) {
        recordExpiryFailure(result, artifact.exportJobId);
        continue;
      }
      await prisma.$transaction(async (tx) => {
        await tx.orgDataExportJob.updateMany({
          where: {
            id: artifact.exportJobId,
            status: "READY",
            startedAt: artifact.attemptStartedAt,
            expiresAt: { lte: now },
          },
          data: { status: "EXPIRED" },
        });
        await tx.orgDataExportArtifact.deleteMany({
          where: {
            exportJobId: artifact.exportJobId,
            attemptStartedAt: artifact.attemptStartedAt,
            lastDeleteAttemptedAt: now,
          },
        });
      });
      result.expired += 1;
    } catch {
      recordExpiryFailure(result, artifact.exportJobId);
    }
  }
}

function recordExpiryFailure(
  result: DataExportResult,
  exportJobId: string,
): void {
  result.expiryFailed += 1;
  result.success = false;
  result.errors.push(
    `export=${exportJobId}: artifact expiry could not be confirmed; owner retained for retry`,
  );
}
