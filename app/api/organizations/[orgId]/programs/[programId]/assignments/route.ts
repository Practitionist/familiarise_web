/**
 * GET  /api/organizations/[orgId]/programs/[programId]/assignments
 * POST /api/organizations/[orgId]/programs/[programId]/assignments
 *
 * Per-member program entitlements. GET lists assignments for the
 * program; POST creates one via `claimProgramAssignment`, which handles
 * the upsert + period uniqueness invariant.
 *
 * Activating a LICENSED_SEAT assignment bumps `activeSeatCount` on the
 * config — the enforcement happens on the next billing cycle when
 * generate-subscription-invoices reads this value.
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { claimProgramAssignment } from "@/lib/api/organizations/program-helpers";
import { adjustActiveSeatCount } from "@/lib/api/organizations/seat-count";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";

const CreateBodySchema = z.object({
  membershipId: z.string().min(1),
  periodStart: z.coerce.date(),
  periodEnd: z.coerce.date(),
});

export async function GET(
  req: NextRequest,
  {
    params,
  }: {
    params: Promise<{ orgId: string; programId: string }>;
  },
) {
  const { orgId, programId } = await params;
  // Read widened to any ACTIVE member. LEARNERs need to see who else
  // is assigned for seat-pool visibility ("how many seats left?").
  // Write endpoints (POST/DELETE) stay MANAGER+canSponsor.
  const access = await requireOrgAccess(orgId);
  if (access.error) return access.error;
  if (!access.org.canSponsor) {
    return NextResponse.json(
      { error: "Organization does not sponsor programs" },
      { status: 404 },
    );
  }

  // Belt-and-braces: don't leak assignments from a program in a
  // sibling org even if the caller knows the programId.
  const program = await prisma.program.findFirst({
    where: { id: programId, contract: { organizationId: orgId } },
    select: { id: true },
  });
  if (!program) {
    return NextResponse.json({ error: "Program not found" }, { status: 404 });
  }

  const url = new URL(req.url);
  const membershipId = url.searchParams.get("membershipId") ?? undefined;

  const assignments = await prisma.programAssignment.findMany({
    where: {
      programId,
      ...(membershipId && { membershipId }),
    },
    include: {
      membership: {
        select: {
          id: true,
          role: true,
          user: { select: { id: true, name: true, email: true } },
        },
      },
    },
    orderBy: { periodStart: "desc" },
  });

  return NextResponse.json({ data: assignments });
}

export async function POST(
  req: NextRequest,
  {
    params,
  }: {
    params: Promise<{ orgId: string; programId: string }>;
  },
) {
  const { orgId, programId } = await params;
  const access = await requireOrgAccess(orgId, {
    minimumRole: "MAINTAINER",
    canSponsor: true,
  });
  if (access.error) return access.error;

  const raw = await req.json().catch(() => null);
  const parsed = CreateBodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body", detail: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const body = parsed.data;
  if (body.periodEnd.getTime() <= body.periodStart.getTime()) {
    return NextResponse.json(
      { error: "periodEnd must be after periodStart" },
      { status: 400 },
    );
  }

  // Cross-org guards: program in this org, membership in this org.
  // One trip to the DB per object keeps the error messages specific —
  // a single findFirst union would surface a generic "not found".
  const program = await prisma.program.findFirst({
    where: { id: programId, contract: { organizationId: orgId } },
    select: { id: true, status: true },
  });
  if (!program) {
    return NextResponse.json({ error: "Program not found" }, { status: 404 });
  }
  if (program.status !== "ACTIVE") {
    return NextResponse.json(
      { error: `Cannot assign to a ${program.status} program` },
      { status: 409 },
    );
  }

  const membership = await prisma.membership.findFirst({
    where: { id: body.membershipId, organizationId: orgId },
    select: { id: true, role: true },
  });
  if (!membership) {
    return NextResponse.json(
      { error: "Membership does not belong to this organization" },
      { status: 400 },
    );
  }

  const assignment = await prisma.$transaction(async (tx) => {
    // claimProgramAssignment reports whether THIS call created the row (atomic
    // INSERT … ON CONFLICT DO NOTHING). Seat-count only on a genuine create, so
    // a re-claim or two concurrent identical POSTs increment activeSeatCount
    // exactly once (the old preexisting-probe was a check-then-act race).
    const { assignment: created, created: isNew } = await claimProgramAssignment(
      tx,
      {
        programId,
        membershipId: body.membershipId,
        periodStart: body.periodStart,
        periodEnd: body.periodEnd,
      },
    );
    if (isNew) {
      await adjustActiveSeatCount(tx, { programId, delta: +1 });
      // #779 — set-point for the persistent money-config lock: the FIRST genuine
      // assignment freezes LOCKED_PROGRAM_FIELDS. updateMany gated on
      // configLockedAt:null so a re-stamp (already-locked program, later
      // assignment) is a no-op and the original lock instant is preserved.
      await tx.program.updateMany({
        where: { id: programId, configLockedAt: null },
        data: { configLockedAt: new Date() },
      });
    }
    await tx.orgAuditLog.create({
      data: {
        organizationId: orgId,
        actorMembershipId: access.member.id,
        targetMembershipId: body.membershipId,
        category: "PROGRAM",
        action: AUDIT_ACTIONS.PROGRAM.PROGRAM_ASSIGNED,
        description: `Assigned membership ${body.membershipId} to program ${programId}`,
        details: {
          programId,
          membershipId: body.membershipId,
          periodStart: body.periodStart.toISOString(),
          periodEnd: body.periodEnd.toISOString(),
        },
      },
    });
    return created;
  });

  return NextResponse.json({ assignment }, { status: 201 });
}
