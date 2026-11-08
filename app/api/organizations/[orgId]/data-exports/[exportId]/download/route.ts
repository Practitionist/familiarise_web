/**
 * GET /api/organizations/[orgId]/data-exports/[exportId]/download
 *
 * Returns a Supabase Storage signed URL for the export bundle when
 * status=READY and the bundle hasn't expired. Successful, unexpired signing
 * writes DATA_EXPORT_DOWNLOAD_REQUESTED; audit latency can still prevent return.
 *
 * Gate: an export grant, and the job's kind must be one the caller holds
 * A MAINTAINER cannot pull a finance bundle.
 */

import { NextResponse, type NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";
import { canHandleExportKind } from "@/lib/enterprise/data-export-kinds";
import { adminStorage } from "@/lib/supabase-storage-core";

function privateJson(data: unknown, init?: ResponseInit): NextResponse {
  const response = NextResponse.json(data, init);
  response.headers.set("Cache-Control", "private, no-store");
  response.headers.set("Vary", "Cookie");
  return response;
}

function privateResponse(response: NextResponse): NextResponse {
  response.headers.set("Cache-Control", "private, no-store");
  response.headers.set("Vary", "Cookie");
  return response;
}

function expiredExportResponse(): NextResponse {
  return privateJson(
    {
      error: "Export bundle has expired; request a fresh one",
      code: "EXPORT_EXPIRED",
    },
    { status: 410 },
  );
}

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
  if (access.error) return privateResponse(access.error);

  const job = await prisma.orgDataExportJob.findFirst({
    where: { id: exportId, organizationId: orgId },
  });
  // A kind the caller can't export reads as absent, not forbidden.
  if (!job || !canHandleExportKind(access.member.role, job.kind)) {
    return privateJson({ error: "Export job not found" }, { status: 404 });
  }
  if (job.status !== "READY" || !job.startedAt || !job.expiresAt) {
    return privateJson(
      {
        error: `Export is ${job.status}; download unavailable`,
        code: "EXPORT_NOT_READY",
      },
      { status: 409 },
    );
  }
  if (job.expiresAt.getTime() <= Date.now()) {
    return expiredExportResponse();
  }

  const artifact = await prisma.orgDataExportArtifact.findUnique({
    where: {
      exportJobId_attemptStartedAt: {
        exportJobId: job.id,
        attemptStartedAt: job.startedAt,
      },
    },
    select: { bucket: true, storagePath: true, expiresAt: true },
  });
  if (!artifact || artifact.expiresAt.getTime() !== job.expiresAt.getTime()) {
    return privateJson(
      { error: "Export bundle is unavailable", code: "EXPORT_UNAVAILABLE" },
      { status: 410 },
    );
  }
  const expiresIn = Math.min(
    60,
    Math.floor((artifact.expiresAt.getTime() - Date.now()) / 1000),
  );
  if (expiresIn < 1) {
    return expiredExportResponse();
  }
  const { data: signed, error: signError } = await adminStorage()
    .from(artifact.bucket)
    .createSignedUrl(artifact.storagePath, expiresIn);
  if (artifact.expiresAt.getTime() <= Date.now()) {
    return expiredExportResponse();
  }
  if (signError || !signed) {
    return privateJson(
      {
        error: "Export bundle is temporarily unavailable",
        code: "EXPORT_UNAVAILABLE",
      },
      { status: 503 },
    );
  }

  await prisma.orgAuditLog.create({
    data: {
      organizationId: orgId,
      actorMembershipId: access.member.id,
      category: "SYSTEM",
      action: AUDIT_ACTIONS.SYSTEM.DATA_EXPORT_DOWNLOAD_REQUESTED,
      description: "Requested a signed download link for a data export",
      details: {
        exportId,
        fileSizeBytes: job.fileSizeBytes?.toString() ?? null,
      },
    },
  });

  if (artifact.expiresAt.getTime() <= Date.now()) {
    return expiredExportResponse();
  }
  return privateJson({ url: signed.signedUrl, expiresAt: job.expiresAt });
}
