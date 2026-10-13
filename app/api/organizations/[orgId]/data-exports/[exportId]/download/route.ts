/**
 * GET /api/organizations/[orgId]/data-exports/[exportId]/download
 *
 * Returns a Supabase Storage signed URL for the export bundle when
 * status=READY and the bundle hasn't expired. The route writes a
 * `DATA_EXPORT_DOWNLOADED` audit row before issuing the redirect so
 * the audit trail captures "who pulled what bundle when".
 *
 * Gate: an export grant, and the job's kind must be one the caller holds
 * (#1527 decision 4) — a MAINTAINER can't pull a finance bundle.
 */

import { NextResponse, type NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";
import { canHandleExportKind } from "@/lib/enterprise/data-export-kinds";

export async function GET(
  _req: NextRequest,
  {
    params,
  }: {
    params: Promise<{ orgId: string; exportId: string }>;
  },
) {
  const { orgId, exportId } = await params;
  const access = await requireOrgAccess(orgId, {
    readOnly: true,
    permission: ["dataExports.people", "dataExports.finance"],
  });
  if (access.error) return access.error;

  const job = await prisma.orgDataExportJob.findFirst({
    where: { id: exportId, organizationId: orgId },
  });
  // A kind the caller can't export reads as absent, not forbidden.
  if (!job || !canHandleExportKind(access.member.role, job.kind)) {
    return NextResponse.json(
      { error: "Export job not found" },
      { status: 404 },
    );
  }
  if (job.status !== "READY" || !job.fileUrl) {
    return NextResponse.json(
      {
        error: `Export is ${job.status}; download unavailable`,
        code: "EXPORT_NOT_READY",
      },
      { status: 409 },
    );
  }
  if (job.expiresAt && job.expiresAt < new Date()) {
    return NextResponse.json(
      {
        error: "Export bundle has expired; request a fresh one",
        code: "EXPORT_EXPIRED",
      },
      { status: 410 },
    );
  }

  await prisma.orgAuditLog.create({
    data: {
      organizationId: orgId,
      actorMembershipId: access.member.id,
      category: "SYSTEM",
      action: AUDIT_ACTIONS.SYSTEM.DATA_EXPORT_DOWNLOADED,
      description: `Downloaded export bundle ${exportId}`,
      details: {
        exportId,
        fileSizeBytes: job.fileSizeBytes?.toString() ?? null,
      },
    },
  });

  return NextResponse.json({ url: job.fileUrl, expiresAt: job.expiresAt });
}
