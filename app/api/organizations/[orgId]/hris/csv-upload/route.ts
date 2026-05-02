/**
 * POST /api/organizations/[orgId]/hris/csv-upload
 *
 * CSV-shaped employee import path. For orgs without a live HRIS integration
 * this is the pragmatic fallback: an admin POSTs a JSON body
 * `{ rows: [{ externalEmployeeId, externalEmail?, externalDepartment?,
 * externalLocation?, externalManagerId? }] }` and we upsert HrisEmployeeMap
 * rows. A CSV-parsing helper can live client-side (or in a follow-up PR
 * here) — the server accepts JSON only.
 *
 * Each row is an upsert by (hrisConfigId, externalEmployeeId) so repeated
 * uploads converge on the latest state. Rows are intentionally NOT linked
 * to Memberships here — a separate reconciliation step matches external
 * employees to platform users by email (that lives in a follow-up PR; the
 * CSV import just stages the raw rows).
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

// 5 MB cap on the JSON body. The Zod schema below already caps row
// count at 5 000, but Zod runs AFTER `req.json()` has buffered the
// whole body into memory. A malicious admin (post-token) could still
// post a 100 MB JSON blob and exhaust process memory before validation
// kicks in. Reject by Content-Length up-front. 5 MB is generous for
// 5 000 rows of ~1 KB each; a real CSV that big should chunk client-
// side and POST in batches.
const MAX_BODY_BYTES = 5 * 1024 * 1024;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const access = await requireOrgOwner(orgId);
  if (access.error) return access.error;

  const contentLength = req.headers.get("content-length");
  if (contentLength) {
    const bytes = parseInt(contentLength, 10);
    if (Number.isFinite(bytes) && bytes > MAX_BODY_BYTES) {
      return NextResponse.json(
        {
          error: "PAYLOAD_TOO_LARGE",
          message: `Body must be <${MAX_BODY_BYTES} bytes (got ${bytes}). Chunk the upload client-side.`,
        },
        { status: 413 },
      );
    }
  }

  const raw = await req.json().catch(() => null);
  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body", detail: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const body = parsed.data;

  // CSV-upload implies a CSV-provider config. `upsert` keyed on the
  // unique `organizationId` races cleanly — two concurrent uploads
  // converge on a single config row instead of one hitting `findUnique`
  // and both hitting `create` + a P2002 violation on the second.
  const config = await prisma.hrisConfig.upsert({
    where: { organizationId: orgId },
    update: {},
    create: {
      organizationId: orgId,
      provider: "CSV",
      tenantKey: `csv:${orgId}`,
      active: true,
    },
  });

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
      // Fan the per-row upserts out across the connection inside one
      // 500-row tx — Prisma serializes them onto the underlying tx
      // connection, but issuing them concurrently lets the server
      // pipeline parses + plans, cutting wall-clock by ~2x for a 500-
      // row chunk vs the previous `for...await` loop. Outer chunking
      // is preserved so commits stay short and partial progress on a
      // mid-batch failure remains visible.
      await prisma.$transaction(async (tx) => {
        await Promise.all(
          chunk.map((row) =>
            tx.hrisEmployeeMap.upsert({
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
            }),
          ),
        );
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
