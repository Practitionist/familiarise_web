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

  // Chunk upserts across multiple transactions. A single 5,000-row tx
  // holds row locks for the full duration and easily exceeds the
  // statement-timeout envelope on small Postgres instances; splitting
  // into 500-row tx windows keeps each commit short and lets the sync
  // job reflect partial progress if a later chunk fails.
  const CHUNK_SIZE = 500;

  const startJob = await prisma.hrisSyncJob.create({
    data: { hrisConfigId, startedAt: now, status: "RUNNING" },
  });

  let processed = 0;
  try {
    for (let i = 0; i < body.rows.length; i += CHUNK_SIZE) {
      const chunk = body.rows.slice(i, i + CHUNK_SIZE);
      await prisma.$transaction(async (tx) => {
        for (const row of chunk) {
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
        }
      });
      processed += chunk.length;
    }
  } catch (err) {
    await prisma.hrisSyncJob.update({
      where: { id: startJob.id },
      data: {
        completedAt: new Date(),
        status: "FAILED",
        recordsProcessed: processed,
        errorLog: err instanceof Error ? err.message : String(err),
      },
    });
    return NextResponse.json(
      { error: "CSV import failed mid-batch", processed },
      { status: 500 },
    );
  }

  const [completedJob] = await prisma.$transaction([
    prisma.hrisSyncJob.update({
      where: { id: startJob.id },
      data: {
        completedAt: new Date(),
        status: "COMPLETED",
        recordsProcessed: processed,
      },
    }),
    prisma.hrisConfig.update({
      where: { id: hrisConfigId },
      data: { lastSyncedAt: now },
    }),
    prisma.orgAuditLog.create({
      data: {
        organizationId: orgId,
        actorMembershipId: access.member.id,
        category: "SYSTEM",
        action: AUDIT_ACTIONS.SYSTEM.HRIS_SYNC_COMPLETED,
        description: `CSV HRIS import: ${processed} rows`,
        details: {
          provider: configForRows.provider,
          tenantKey: configForRows.tenantKey,
          recordsProcessed: processed,
          jobId: startJob.id,
        },
      },
    }),
  ]);

  return NextResponse.json({ processed, job: completedJob });
}
