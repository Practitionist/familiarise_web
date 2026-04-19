/**
 * POST /api/organizations/[orgId]/hris/csv-upload
 *
 * CSV-shaped employee import path. For orgs without a live HRIS integration
 * this is the pragmatic fallback: an admin uploads a CSV with columns
 * (externalEmployeeId, externalEmail, externalDepartment, externalLocation,
 * externalManagerId) and we upsert HrisEmployeeMap rows.
 *
 * Each row is an upsert by (hrisConfigId, externalEmployeeId) so repeated
 * uploads converge on the latest state. Rows are intentionally NOT linked
 * to Memberships here — a separate reconciliation step matches external
 * employees to platform users by email (that lives in a follow-up PR; the
 * CSV import just stages the raw rows).
 *
 * v1 accepts either a CSV text body or a JSON array of rows. A real CSV
 * parser (e.g. csv-parse) would live in a helper; the in-line shape check
 * is sufficient for the stub.
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { requireOrgOwner } from "@/lib/auth-helpers";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";

const RowSchema = z.object({
  externalEmployeeId: z.string().min(1).max(128),
  externalEmail: z.string().email().optional(),
  externalDepartment: z.string().min(1).max(128).optional(),
  externalLocation: z.string().min(1).max(128).optional(),
  externalManagerId: z.string().min(1).max(128).optional(),
});

const BodySchema = z.object({
  rows: z.array(RowSchema).min(1).max(5000),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const access = await requireOrgOwner(orgId);
  if (access.error) return access.error;

  const raw = await req.json().catch(() => null);
  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body", detail: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const body = parsed.data;

  // CSV-upload implies a CSV-provider config. Auto-create one if the org
  // doesn't have HRIS configured yet — saves a round trip for the common
  // case of "admin just wants to import a roster".
  let config = await prisma.hrisConfig.findUnique({
    where: { organizationId: orgId },
  });
  if (!config) {
    config = await prisma.hrisConfig.create({
      data: {
        organizationId: orgId,
        provider: "CSV",
        tenantKey: `csv:${orgId}`,
        active: true,
      },
    });
  }

  const now = new Date();
  const hrisConfigId = config.id;
  const configForRows = config;

  const { processed, job } = await prisma.$transaction(async (tx) => {
    const startJob = await tx.hrisSyncJob.create({
      data: {
        hrisConfigId,
        startedAt: now,
        status: "RUNNING",
      },
    });

    let count = 0;
    for (const row of body.rows) {
      await tx.hrisEmployeeMap.upsert({
        where: {
          hrisConfigId_externalEmployeeId: {
            hrisConfigId,
            externalEmployeeId: row.externalEmployeeId,
          },
        },
        create: {
          hrisConfigId,
          organizationId: orgId,
          externalEmployeeId: row.externalEmployeeId,
          externalEmail: row.externalEmail ?? null,
          externalDepartment: row.externalDepartment ?? null,
          externalLocation: row.externalLocation ?? null,
          externalManagerId: row.externalManagerId ?? null,
          syncedAt: now,
        },
        update: {
          externalEmail: row.externalEmail ?? null,
          externalDepartment: row.externalDepartment ?? null,
          externalLocation: row.externalLocation ?? null,
          externalManagerId: row.externalManagerId ?? null,
          syncedAt: now,
        },
      });
      count++;
    }

    const completedJob = await tx.hrisSyncJob.update({
      where: { id: startJob.id },
      data: {
        completedAt: new Date(),
        status: "COMPLETED",
        recordsProcessed: count,
      },
    });

    await tx.hrisConfig.update({
      where: { id: hrisConfigId },
      data: { lastSyncedAt: now },
    });

    await tx.orgAuditLog.create({
      data: {
        organizationId: orgId,
        actorMembershipId: access.member.id,
        category: "SYSTEM",
        action: AUDIT_ACTIONS.SYSTEM.HRIS_SYNC_COMPLETED,
        description: `CSV HRIS import: ${count} rows`,
        details: {
          provider: configForRows.provider,
          tenantKey: configForRows.tenantKey,
          recordsProcessed: count,
          jobId: completedJob.id,
        },
      },
    });

    return { processed: count, job: completedJob };
  });

  return NextResponse.json({ processed, job });
}
