/**
 * GET  /api/organizations/[orgId]/hris/sync
 * POST /api/organizations/[orgId]/hris/sync
 *
 * GET lists recent sync jobs; POST starts a new one (or returns the
 * running one if there's already an in-flight sync). The actual pull-
 * from-vendor logic lives in jobs/hris/** — this endpoint only records
 * the intent + lifecycle. Because real HRIS adapters aren't wired in v1,
 * POST currently transitions RUNNING → COMPLETED in-line and records
 * zero records processed, letting the UI exercise the status flow.
 */

import { NextResponse, type NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import { requireOrgAccess, requireOrgOwner } from "@/lib/auth-helpers";
import { ENABLE_HRIS } from "@/lib/feature-flags";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";
import { recordSystemError } from "@/lib/enterprise/system-events";

// Match the gating posture in the parent /hris route — return 404 when
// ENABLE_HRIS is off so a flag-flip is the single switch to expose the
// whole subsystem.
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
    select: { id: true },
  });
  if (!config) {
    return NextResponse.json(
      { error: "HRIS not configured for this organization" },
      { status: 404 },
    );
  }

  const jobs = await prisma.hrisSyncJob.findMany({
    where: { hrisConfigId: config.id },
    orderBy: { startedAt: "desc" },
    take: 25,
  });

  return NextResponse.json({ data: jobs });
}

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const gated = notFoundIfGated();
  if (gated) return gated;
  const { orgId } = await params;
  const access = await requireOrgOwner(orgId);
  if (access.error) return access.error;

  const config = await prisma.hrisConfig.findUnique({
    where: { organizationId: orgId },
  });
  if (!config) {
    return NextResponse.json(
      { error: "HRIS not configured for this organization" },
      { status: 404 },
    );
  }
  if (!config.active) {
    return NextResponse.json(
      { error: "HRIS connector is inactive — enable it first" },
      { status: 409 },
    );
  }

  // Return the existing run instead of starting a duplicate.
  const inFlight = await prisma.hrisSyncJob.findFirst({
    where: { hrisConfigId: config.id, status: { in: ["PENDING", "RUNNING"] } },
    orderBy: { startedAt: "desc" },
  });
  if (inFlight) {
    return NextResponse.json(
      { job: inFlight, note: "Sync already in progress" },
      { status: 202 },
    );
  }

  const now = new Date();
  try {
    const [job] = await prisma.$transaction([
      prisma.hrisSyncJob.create({
        data: {
          hrisConfigId: config.id,
          startedAt: now,
          // Marking completed immediately reflects the v1 stub — the
          // real async-pull lands in a follow-up PR that flips
          // PENDING → RUNNING → COMPLETED from the job runner.
          completedAt: now,
          status: "COMPLETED",
          recordsProcessed: 0,
        },
      }),
      prisma.hrisConfig.update({
        where: { id: config.id },
        data: { lastSyncedAt: now },
      }),
      prisma.orgAuditLog.create({
        data: {
          organizationId: orgId,
          actorMembershipId: access.member.id,
          category: "SYSTEM",
          action: AUDIT_ACTIONS.SYSTEM.HRIS_SYNC_STARTED,
          description: `HRIS sync started (${config.provider})`,
          details: { provider: config.provider, tenantKey: config.tenantKey },
        },
      }),
      // v1 stub transitions RUNNING → COMPLETED in-line, so emit the
      // terminal audit row alongside STARTED. When the real job runner
      // lands, this COMPLETED row will instead be emitted from the
      // worker on successful pull.
      prisma.orgAuditLog.create({
        data: {
          organizationId: orgId,
          actorMembershipId: access.member.id,
          category: "SYSTEM",
          action: AUDIT_ACTIONS.SYSTEM.HRIS_SYNC_COMPLETED,
          description: `HRIS sync completed (${config.provider}) — 0 records`,
          details: {
            provider: config.provider,
            tenantKey: config.tenantKey,
            recordsProcessed: 0,
          },
        },
      }),
    ]);

    return NextResponse.json({ job }, { status: 201 });
  } catch (err) {
    // Two surfaces for the same failure — clean org-visible audit row,
    // engineering-only system event with the raw error + stack. The
    // org owner sees "HRIS sync failed (Workday)" and can act on it
    // (retry / contact support); engineering gets the actionable
    // payload in system_events. Both writes are best-effort so the
    // route still surfaces its 500 to the caller.
    await prisma.orgAuditLog
      .create({
        data: {
          organizationId: orgId,
          actorMembershipId: access.member.id,
          category: "SYSTEM",
          action: AUDIT_ACTIONS.SYSTEM.HRIS_SYNC_FAILED,
          description: `HRIS sync failed (${config.provider}) — engineering team notified.`,
          details: {
            provider: config.provider,
            tenantKey: config.tenantKey,
          },
        },
      })
      .catch(() => null);

    await recordSystemError({
      organizationId: orgId,
      category: "HRIS_SYNC",
      summary: `HRIS sync failed (${config.provider})`,
      err,
      context: { provider: config.provider, tenantKey: config.tenantKey },
    });

    throw err;
  }
}
