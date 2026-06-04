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
import { getProgramLockState } from "@/lib/enterprise/config-lock";

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

const OverageBehaviorSchema = z.enum(["BLOCK", "CHARGE_MEMBER", "CHARGE_ORG"]);

const PatchBodySchema = z
  .object({
    name: z.string().min(2).max(120).optional(),
    status: ProgramStatusSchema.optional(),
    // #777 §B — archive/unarchive (soft-hide; never hard-delete once in use).
    archived: z.boolean().optional(),
    coveredPlanTypes: z.array(CoveredPlanTypeSchema).optional(),
    allowedCategories: z.array(z.string()).optional(),
    // Money config — locked once the program is in use (#777 §B). Type isn't
    // editable post-create (it picks which config table exists); the per-type
    // money fields below route to licensedSeatConfig / creditPoolConfig.
    ratePerSeatPaise: z.coerce.number().int().min(0).optional(),
    coveredEngagementsPerCycle: z.coerce
      .number()
      .int()
      .min(1)
      .nullable()
      .optional(),
    creditsPerCycle: z.coerce.number().int().min(1).optional(),
    overageBehavior: OverageBehaviorSchema.optional(),
    overageSurchargeBps: z.coerce.number().int().min(0).nullable().optional(),
    priceCapPerEngagementPaise: z.coerce
      .number()
      .int()
      .min(0)
      .nullable()
      .optional(),
    maxOveragePerCyclePaise: z.coerce.number().int().min(0).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: "PATCH body must contain at least one field",
  });

// Fields whose edit rewrites already-settled money — gated by the in-use
// lock (#777 §B). `coveredPlanTypes` counts: it decides what a seat covers.
const MONEY_FIELDS = [
  "coveredPlanTypes",
  "ratePerSeatPaise",
  "coveredEngagementsPerCycle",
  "creditsPerCycle",
  "overageBehavior",
  "overageSurchargeBps",
  "priceCapPerEngagementPaise",
  "maxOveragePerCyclePaise",
] as const;

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
  // Surface the in-use lock so the edit dialog can disable money fields
  // without a second round-trip (#777 §B).
  const { locked } = await getProgramLockState(programId);
  return NextResponse.json({ program: { ...program, locked } });
}

// TODO(#777 server-actions): kept as a Route Handler + useMutation to match the
// rest of the dashboard. New first-party form mutations should prefer a Server
// Action (co-located write + revalidate, progressive enhancement) per the
// agreed direction — migrate this when the dashboard converges on that pattern.
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

  // Reject any money-field edit on a program that's already in use — a
  // retroactive change would rewrite bookings settled at the old terms.
  // `name`/`status`/`allowedCategories` stay editable always (#777 §B).
  const touchesMoney = MONEY_FIELDS.some((f) => body[f] !== undefined);
  if (touchesMoney) {
    const { locked } = await getProgramLockState(programId);
    if (locked) {
      return NextResponse.json(
        {
          error:
            "Program is in use — money config is locked. Only the name can be changed.",
          code: "PROGRAM_CONFIG_LOCKED",
        },
        { status: 409 },
      );
    }
  }

  try {
    const updated = await prisma.$transaction(async (tx) => {
      const current = await tx.program.findFirst({
        where: { id: programId, contract: { organizationId: orgId } },
      });
      if (!current) {
        throw Object.assign(new Error("Program not found"), { httpStatus: 404 });
      }

      // #777 §B — archiving guard: an archived program is skipped by the cycle
      // engine, so live allocations under it would zombie (never roll, never
      // close). Force the operator to cancel them (or let the cycle end) first.
      if (body.archived === true) {
        const activeAssignments = await tx.programAssignment.count({
          where: {
            programId,
            status: "ACTIVE",
            periodEnd: { gte: new Date() },
          },
        });
        if (activeAssignments > 0) {
          throw Object.assign(
            new Error(
              `Cannot archive a program with ${activeAssignments} active assignment(s). Cancel them or let the cycle end first.`,
            ),
            {
              httpStatus: 409,
              code: "PROGRAM_HAS_ACTIVE_ASSIGNMENTS",
            },
          );
        }
      }

      const next = await tx.program.update({
        where: { id: programId },
        data: {
          ...(body.name !== undefined && { name: body.name }),
          ...(body.status !== undefined && { status: body.status }),
          ...(body.archived !== undefined && {
            archivedAt: body.archived ? new Date() : null,
          }),
          ...(body.coveredPlanTypes !== undefined && {
            coveredPlanTypes: body.coveredPlanTypes,
          }),
          ...(body.allowedCategories !== undefined && {
            allowedCategories: body.allowedCategories,
          }),
        },
      });

      // Per-type money fields route to the live config table. `type` is
      // immutable post-create, so the existing config row is the target —
      // unreachable fields (e.g. ratePerSeatPaise on a CREDIT_POOL) are
      // simply absent from the body and skipped.
      if (current.type === "LICENSED_SEAT") {
        const seatData = {
          ...(body.ratePerSeatPaise !== undefined && {
            ratePerSeatPaise: body.ratePerSeatPaise,
          }),
          ...(body.coveredEngagementsPerCycle !== undefined && {
            coveredEngagementsPerCycle: body.coveredEngagementsPerCycle,
          }),
          ...(body.overageBehavior !== undefined && {
            overageBehavior: body.overageBehavior,
          }),
          ...(body.overageSurchargeBps !== undefined && {
            overageSurchargeBps: body.overageSurchargeBps,
          }),
          ...(body.priceCapPerEngagementPaise !== undefined && {
            priceCapPerEngagementPaise: body.priceCapPerEngagementPaise,
          }),
          ...(body.maxOveragePerCyclePaise !== undefined && {
            maxOveragePerCyclePaise: body.maxOveragePerCyclePaise,
          }),
        };
        if (Object.keys(seatData).length > 0) {
          await tx.licensedSeatConfig.update({
            where: { programId },
            data: seatData,
          });
        }
      } else if (current.type === "CREDIT_POOL") {
        const poolData = {
          ...(body.creditsPerCycle !== undefined && {
            creditsPerCycle: body.creditsPerCycle,
          }),
          ...(body.overageBehavior !== undefined && {
            overageBehavior: body.overageBehavior,
          }),
          ...(body.overageSurchargeBps !== undefined && {
            overageSurchargeBps: body.overageSurchargeBps,
          }),
          ...(body.maxOveragePerCyclePaise !== undefined && {
            maxOveragePerCyclePaise: body.maxOveragePerCyclePaise,
          }),
        };
        if (Object.keys(poolData).length > 0) {
          await tx.creditPoolConfig.update({
            where: { programId },
            data: poolData,
          });
        }
      }

      // Archive/unarchive gets its own audit action (#777 §B).
      if (
        body.archived !== undefined &&
        body.archived !== (current.archivedAt != null)
      ) {
        await tx.orgAuditLog.create({
          data: {
            organizationId: orgId,
            actorMembershipId: access.member.id,
            category: "PROGRAM",
            action: AUDIT_ACTIONS.PROGRAM.PROGRAM_ARCHIVED,
            description: `Program ${programId} ${body.archived ? "archived" : "unarchived"}`,
            details: { programId, archived: body.archived },
          },
        });
      }

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
