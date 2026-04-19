/**
 * GET    /api/organizations/[orgId]/programs/[programId]/assignments/[assignmentId]
 * PATCH  /api/organizations/[orgId]/programs/[programId]/assignments/[assignmentId]
 * DELETE /api/organizations/[orgId]/programs/[programId]/assignments/[assignmentId]
 *
 * DELETE is narrow: an assignment with recorded BookingUtilizations
 * cannot be deleted — the usage ledger would lose its anchor. Instead,
 * PATCH sessionsUsed / overageCount or let the periodEnd pass naturally.
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";

const PatchBodySchema = z
  .object({
    periodStart: z.coerce.date().optional(),
    periodEnd: z.coerce.date().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: "PATCH body must contain at least one field",
  });

export async function GET(
  _req: NextRequest,
  {
    params,
  }: {
    params: Promise<{ orgId: string; programId: string; assignmentId: string }>;
  },
) {
  const { orgId, programId, assignmentId } = await params;
  const access = await requireOrgAccess(orgId);
  if (access.error) return access.error;

  const assignment = await prisma.programAssignment.findFirst({
    where: {
      id: assignmentId,
      programId,
      program: { contract: { organizationId: orgId } },
    },
    include: {
      membership: { include: { user: { select: { id: true, name: true, email: true } } } },
      utilizations: { orderBy: { createdAt: "desc" }, take: 50 },
    },
  });
  if (!assignment) {
    return NextResponse.json({ error: "Assignment not found" }, { status: 404 });
  }
  return NextResponse.json({ assignment });
}

export async function PATCH(
  req: NextRequest,
  {
    params,
  }: {
    params: Promise<{ orgId: string; programId: string; assignmentId: string }>;
  },
) {
  const { orgId, programId, assignmentId } = await params;
  const access = await requireOrgAccess(orgId, "MAINTAINER");
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
      const current = await tx.programAssignment.findFirst({
        where: {
          id: assignmentId,
          programId,
          program: { contract: { organizationId: orgId } },
        },
      });
      if (!current) {
        throw Object.assign(new Error("Assignment not found"), {
          httpStatus: 404,
        });
      }
      const nextStart = body.periodStart ?? current.periodStart;
      const nextEnd = body.periodEnd ?? current.periodEnd;
      if (nextEnd.getTime() <= nextStart.getTime()) {
        throw Object.assign(
          new Error("periodEnd must be after periodStart"),
          { httpStatus: 400 },
        );
      }
      return tx.programAssignment.update({
        where: { id: assignmentId },
        data: {
          periodStart: nextStart,
          periodEnd: nextEnd,
        },
      });
    });
    return NextResponse.json({ assignment: updated });
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
    params: Promise<{ orgId: string; programId: string; assignmentId: string }>;
  },
) {
  const { orgId, programId, assignmentId } = await params;
  const access = await requireOrgAccess(orgId, "MAINTAINER");
  if (access.error) return access.error;

  try {
    await prisma.$transaction(async (tx) => {
      const current = await tx.programAssignment.findFirst({
        where: {
          id: assignmentId,
          programId,
          program: { contract: { organizationId: orgId } },
        },
        include: { _count: { select: { utilizations: true } } },
      });
      if (!current) {
        throw Object.assign(new Error("Assignment not found"), {
          httpStatus: 404,
        });
      }
      if (current._count.utilizations > 0) {
        throw Object.assign(
          new Error(
            "Cannot delete an assignment with recorded utilizations. Let the period expire or archive the program instead.",
          ),
          { httpStatus: 409 },
        );
      }
      await tx.programAssignment.delete({ where: { id: assignmentId } });
      await tx.orgAuditLog.create({
        data: {
          organizationId: orgId,
          actorMembershipId: access.member.id,
          targetMembershipId: current.membershipId,
          category: "PROGRAM",
          action: AUDIT_ACTIONS.PROGRAM.PROGRAM_UNASSIGNED,
          description: `Unassigned ${current.membershipId} from program ${programId}`,
          details: { programId, assignmentId },
        },
      });
    });
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
