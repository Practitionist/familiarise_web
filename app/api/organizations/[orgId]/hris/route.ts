/**
 * GET   /api/organizations/[orgId]/hris
 * PUT   /api/organizations/[orgId]/hris
 * DELETE /api/organizations/[orgId]/hris
 *
 * HRIS connector config. One HrisConfig per org — tenantKey + provider
 * identify the remote tenant. PUT is upsert (idempotent); DELETE removes
 * the config + cascades to sync jobs + employee-map rows.
 *
 * The sync itself runs out-of-band in jobs/hris/**. This endpoint only
 * manages the connector record — credentials are intentionally not stored
 * here for v1 (CSV-only onboarding keeps secrets out of the DB). The
 * Workday/BambooHR etc. branches are schema-ready; the wiring is in the
 * follow-up implementation PR.
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { requireOrgAccess, requireOrgOwner } from "@/lib/auth-helpers";
import { ENABLE_HRIS } from "@/lib/feature-flags";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";

const HrisProviderSchema = z.enum([
  "WORKDAY",
  "BAMBOOHR",
  "SAP",
  "ORACLE",
  "CERIDIAN",
  "DARWINBOX",
  "CSV",
]);

const UpsertBodySchema = z.object({
  provider: HrisProviderSchema,
  tenantKey: z.string().min(1).max(256),
  active: z.boolean().optional(),
});

// HRIS provider sync wiring isn't shipped in v1 — schema + connector
// records exist, but Workday/BambooHR/etc. workers are stubbed. Return
// 404 when the flag is off so the endpoint is invisible to callers.
// Flip ENABLE_HRIS=true once the first design-partner sync is live.
function notFoundIfGated() {
  if (!ENABLE_HRIS) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return null;
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const gated = notFoundIfGated();
  if (gated) return gated;
  const { orgId } = await params;
  const access = await requireOrgAccess(orgId, "MANAGER");
  if (access.error) return access.error;

  const config = await prisma.hrisConfig.findUnique({
    where: { organizationId: orgId },
    include: {
      _count: { select: { syncJobs: true, employeeMap: true } },
      syncJobs: {
        orderBy: { startedAt: "desc" },
        take: 5,
        select: {
          id: true,
          startedAt: true,
          completedAt: true,
          status: true,
          recordsProcessed: true,
        },
      },
    },
  });

  return NextResponse.json({ config: config ?? null });
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const gated = notFoundIfGated();
  if (gated) return gated;
  const { orgId } = await params;
  const access = await requireOrgOwner(orgId);
  if (access.error) return access.error;

  const raw = await req.json().catch(() => null);
  const parsed = UpsertBodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body", detail: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const body = parsed.data;

  const [config] = await prisma.$transaction([
    prisma.hrisConfig.upsert({
      where: { organizationId: orgId },
      create: {
        organizationId: orgId,
        provider: body.provider,
        tenantKey: body.tenantKey,
        active: body.active ?? false,
      },
      update: {
        provider: body.provider,
        tenantKey: body.tenantKey,
        ...(body.active !== undefined && { active: body.active }),
      },
    }),
    prisma.orgAuditLog.create({
      data: {
        organizationId: orgId,
        actorMembershipId: access.member.id,
        category: "SETTINGS",
        action: AUDIT_ACTIONS.SETTINGS.SETTINGS_CHANGED,
        description: `HRIS connector configured (${body.provider})`,
        details: {
          provider: body.provider,
          tenantKey: body.tenantKey,
          active: body.active ?? false,
        },
      },
    }),
  ]);

  return NextResponse.json({ config });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const gated = notFoundIfGated();
  if (gated) return gated;
  const { orgId } = await params;
  const access = await requireOrgOwner(orgId);
  if (access.error) return access.error;

  const existing = await prisma.hrisConfig.findUnique({
    where: { organizationId: orgId },
  });
  if (!existing) {
    return NextResponse.json({ error: "No HRIS config" }, { status: 404 });
  }

  await prisma.$transaction([
    prisma.hrisConfig.delete({ where: { organizationId: orgId } }),
    prisma.orgAuditLog.create({
      data: {
        organizationId: orgId,
        actorMembershipId: access.member.id,
        category: "SETTINGS",
        action: AUDIT_ACTIONS.SETTINGS.SETTINGS_CHANGED,
        description: "HRIS connector removed",
        details: { provider: existing.provider, tenantKey: existing.tenantKey },
      },
    }),
  ]);

  return new NextResponse(null, { status: 204 });
}
