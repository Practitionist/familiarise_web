/**
 * GET    /api/organizations/[orgId]/programs/[programId]
 * PATCH  /api/organizations/[orgId]/programs/[programId]
 * DELETE /api/organizations/[orgId]/programs/[programId]
 *
 * DELETE is DRAFT-only (same posture as /contracts). Active programs
 * must be PAUSED via PATCH first — this preserves the audit trail and
 * prevents orphaning ProgramAssignments.
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";

const ProgramStatusSchema = z.enum([
  "ACTIVE",
  "PAUSED",
  "EXPIRED",
  "CANCELLED",
]);

const CoveredPlanTypeSchema = z.enum([
  "CONSULTATION",
  "CLASS",
  "WEBINAR",
  "SUBSCRIPTION",
]);

const PatchBodySchema = z
  .object({
    name: z.string().min(2).max(120).optional(),
    status: ProgramStatusSchema.optional(),
    coveredPlanTypes: z.array(CoveredPlanTypeSchema).optional(),
    allowedCategories: z.array(z.string()).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: "PATCH body must contain at least one field",
  });

export async function GET(
  _req: NextRequest,
  {
    params,
  }: {
    params: Promise<{ orgId: string; programId: string }>;
  },
) {
  const { orgId, programId } = await params;
  // Read widened to any ACTIVE member: a LEARNER assigned to a program
  // needs to see the program's rules (covered plan types, pool balance)
  // to understand what they can book. Mutations stay MANAGER+ below.
  const access = await requireOrgAccess(orgId);
  if (access.error) return access.error;
  if (!access.org.canSponsor) {
    return NextResponse.json(
      { error: "Organization does not sponsor programs" },
      { status: 404 },
    );
  }

  const program = await prisma.program.findFirst({
    where: { id: programId, contract: { organizationId: orgId } },
    include: {
      licensedSeatConfig: true,
      creditPoolConfig: true,
      contract: {
        select: { id: true, status: true, effectiveFrom: true, effectiveTo: true },
      },
      _count: { select: { assignments: true } },
    },
  });
  if (!program) {
    return NextResponse.json({ error: "Program not found" }, { status: 404 });
  }
  return NextResponse.json({ program });
}

export async function PATCH(
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
  const parsed = PatchBodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body", detail: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const body = parsed.data;

  try {
    const updated = await prisma.$transaction(async (tx) => {
      const current = await tx.program.findFirst({
        where: { id: programId, contract: { organizationId: orgId } },
      });
      if (!current) {
        throw Object.assign(new Error("Program not found"), { httpStatus: 404 });
      }
      const next = await tx.program.update({
        where: { id: programId },
        data: {
          ...(body.name !== undefined && { name: body.name }),
          ...(body.status !== undefined && { status: body.status }),
          ...(body.coveredPlanTypes !== undefined && {
            coveredPlanTypes: body.coveredPlanTypes,
          }),
          ...(body.allowedCategories !== undefined && {
            allowedCategories: body.allowedCategories,
          }),
        },
      });

      // Status transitions get the dedicated PROGRAM_PAUSED action so
      // the audit timeline shows the lifecycle event separately from a
      // plain rename.
      if (body.status && body.status !== current.status) {
        await tx.orgAuditLog.create({
          data: {
            organizationId: orgId,
            actorMembershipId: access.member.id,
            category: "PROGRAM",
            action:
              body.status === "PAUSED"
                ? AUDIT_ACTIONS.PROGRAM.PROGRAM_PAUSED
                : AUDIT_ACTIONS.PROGRAM.PROGRAM_CREATED,
            description: `Program ${programId}: ${current.status} → ${body.status}`,
            details: {
              programId,
              from: current.status,
              to: body.status,
            },
          },
        });
      }

      return next;
    });
    return NextResponse.json({ program: updated });
  } catch (err) {
    if (err instanceof Error && "httpStatus" in err) {
      const status =
        typeof err.httpStatus === "number" ? err.httpStatus : 500;
      return NextResponse.json({ error: err.message }, { status });
    }
    throw err;
  }
}

export async function DELETE(
  _req: NextRequest,
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

  try {
    // Serializable isolation closes the race where assignment-creation
    // and program-deletion run concurrently: both transactions read
    // assignments=0, both proceed, and the delete cascades the
    // newly-created assignment. Postgres detects the read/write
    // dependency cycle under SERIALIZABLE and aborts one with P2034
    // (which Prisma surfaces as a retryable serialization error). The
    // explicit assignment count + utilization check inside the tx still
    // runs first as a fast-fail.
    await prisma.$transaction(
      async (tx) => {
        const current = await tx.program.findFirst({
          where: { id: programId, contract: { organizationId: orgId } },
          include: { _count: { select: { assignments: true } } },
        });
        if (!current) {
          throw Object.assign(new Error("Program not found"), { httpStatus: 404 });
        }
        if (current._count.assignments > 0) {
          throw Object.assign(
            new Error(
              "Cannot delete a program with active assignments. Pause it instead (PATCH status=PAUSED).",
            ),
            { httpStatus: 409 },
          );
        }

        // Even when assignments=0, a current-cycle BookingUtilization
        // can exist via a reversed-but-not-removed history row. Refuse
        // the hard delete if any utilization in the current period is
        // still queryable — the audit trail would otherwise lose its
        // foreign-key target.
        const utilizationStillPresent = await tx.bookingUtilization.findFirst({
          where: { programAssignment: { programId } },
          select: { id: true },
        });
        if (utilizationStillPresent) {
          throw Object.assign(
            new Error(
              "Program has historical utilization rows. Pause via PATCH status=CANCELLED instead of deleting.",
            ),
            { httpStatus: 409 },
          );
        }

        await tx.program.delete({ where: { id: programId } });
        await tx.orgAuditLog.create({
          data: {
            organizationId: orgId,
            actorMembershipId: access.member.id,
            category: "PROGRAM",
            action: AUDIT_ACTIONS.PROGRAM.PROGRAM_DELETED,
            description: `Program ${programId} deleted (no assignments)`,
            details: { programId },
          },
        });
      },
      { isolationLevel: "Serializable" },
    );
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    if (err instanceof Error && "httpStatus" in err) {
      const status =
        typeof err.httpStatus === "number" ? err.httpStatus : 500;
      return NextResponse.json({ error: err.message }, { status });
    }
    throw err;
  }
}
