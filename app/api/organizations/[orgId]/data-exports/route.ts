/**
 * GET  /api/organizations/[orgId]/data-exports — list export jobs (last 30 days).
 * POST /api/organizations/[orgId]/data-exports — request a fresh export bundle.
 *
 * DPDP §11 right-to-access surface. The user can pull a JSON+CSV
 * archive of every entity scoped to their org (members, contracts,
 * programs, invoices, earnings, payouts, audit log). The worker
 * (`scripts/cleanup/process-data-exports.ts`) does the heavy lifting
 * asynchronously; this route just files the request and returns the
 * row so the dashboard can poll for status.
 *
 * Gate (#1527 decision 4): a bundle has a kind — `people` (members + audit,
 * `dataExports.people`: OWNER, MAINTAINER) or `finance` (contracts,
 * programs, invoices, earnings, payouts, `dataExports.finance`: OWNER,
 * BILLING_ADMIN). A caller requests only a kind they hold and lists only
 * jobs of kinds they hold.
 *
 * Rate limit: 1 per 24h per org per kind (`orgDataExportLimiter`). Building a
 * full bundle is O(N × entities); we don't want a single org pulling
 * 24 bundles in a day even if their integrators allow it.
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";
import {
  DATA_EXPORT_KINDS,
  canHandleExportKind,
} from "@/lib/enterprise/data-export-kinds";
import { loadExportKinds } from "@/lib/enterprise/data-export-jobs";
import { applyRateLimit, orgDataExportLimiter } from "@/lib/rate-limit";

const EXPORT_GRANTS = ["dataExports.people", "dataExports.finance"] as const;

const RequestBodySchema = z.object({ kind: z.enum(DATA_EXPORT_KINDS) });

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const access = await requireOrgAccess(orgId, { permission: EXPORT_GRANTS });
  if (access.error) return access.error;

  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const exports = await prisma.orgDataExportJob.findMany({
    where: { organizationId: orgId, createdAt: { gte: thirtyDaysAgo } },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: {
      id: true,
      status: true,
      requestedByMembershipId: true,
      fileSizeBytes: true,
      expiresAt: true,
      error: true,
      createdAt: true,
      startedAt: true,
      completedAt: true,
    },
  });
  const kinds = await loadExportKinds(
    orgId,
    exports.map((e) => e.id),
  );
  const role = access.member.role;
  return NextResponse.json({
    data: exports
      .map((e) => ({ ...e, kind: kinds.get(e.id) ?? null }))
      .filter((e) => canHandleExportKind(role, e.kind)),
  });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const access = await requireOrgAccess(orgId, { permission: EXPORT_GRANTS });
  if (access.error) return access.error;

  const parsed = RequestBodySchema.safeParse(
    await req.json().catch(() => null),
  );
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Choose which bundle to export", code: "EXPORT_KIND_REQUIRED" },
      { status: 400 },
    );
  }
  const { kind } = parsed.data;
  if (!canHandleExportKind(access.member.role, kind)) {
    return NextResponse.json(
      {
        error: `Your role can't export the ${kind} bundle`,
        code: "EXPORT_KIND_FORBIDDEN",
      },
      { status: 403 },
    );
  }

  // Per kind, so a finance export doesn't block the people bundle's owner.
  const rl = await applyRateLimit(orgDataExportLimiter, `org:${orgId}:${kind}`);
  if (rl) return rl;

  const created = await prisma.$transaction(async (tx) => {
    const job = await tx.orgDataExportJob.create({
      data: {
        organizationId: orgId,
        requestedByMembershipId: access.member.id,
        status: "PENDING",
      },
    });
    await tx.orgAuditLog.create({
      data: {
        organizationId: orgId,
        actorMembershipId: access.member.id,
        category: "SYSTEM",
        action: AUDIT_ACTIONS.SYSTEM.DATA_EXPORT_REQUESTED,
        description: `Requested org data export (${kind})`,
        // The worker and the list read the kind back from here — the job
        // row has no kind column (lib/enterprise/data-export-kinds.ts).
        details: { exportId: job.id, kind },
      },
    });
    return job;
  });

  return NextResponse.json({ export: created }, { status: 202 });
}
