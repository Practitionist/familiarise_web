/**
 * POST /api/organizations/[orgId]/programs/[programId]/supersede
 *
 * Programs lock their commercial configuration (`configLockedAt`) once the first
 * seat is assigned so historical bookings and utilization records are never
 * retroactively repriced. To amend a locked program's commercial terms, callers
 * supersede it: this route atomically clones the program, its typed config
 * (`LicensedSeatConfig` or `CreditPoolConfig`), and its curated consultant
 * allowlist with the amended fields, migrates active seat assignments to the
 * successor program without net-changing `BillingSubscription.activeSeatCount`,
 * and retires (`CANCELLED` + `archivedAt`) the superseded program.
 */

import * as Sentry from "@sentry/nextjs";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { computeCycleEnd } from "@/lib/enterprise/cycle-engine";
import { overageConfigRefusals } from "@/lib/enterprise/reachable-paths";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";

const CoveredPlanTypeSchema = z.enum([
  "CONSULTATION",
  "CLASS",
  "WEBINAR",
  "SUBSCRIPTION",
]);

const OverageBehaviorSchema = z.enum(["BLOCK", "CHARGE_MEMBER", "CHARGE_ORG"]);

const BillingCycleSchema = z.enum(["MONTHLY", "QUARTERLY", "ANNUAL"]);

const SupersedeProgramBodySchema = z
  .object({
    name: z.string().min(2).max(120).optional(),
    coveredPlanTypes: z.array(CoveredPlanTypeSchema).min(1).optional(),
    allowedCategories: z.array(z.string()).optional(),
    cycle: BillingCycleSchema.optional(),
    ratePerSeatPaise: z.coerce.number().int().min(0).optional(),
    coveredEngagementsPerCycle: z.coerce
      .number()
      .int()
      .min(1)
      .nullable()
      .optional(),
    creditBudgetPerCycle: z.coerce.number().int().min(1).optional(),
    overageBehavior: OverageBehaviorSchema.optional(),
    overageSurchargeBps: z.coerce.number().int().min(0).nullable().optional(),
    priceCapPerEngagementPaise: z.coerce
      .number()
      .int()
      .min(0)
      .nullable()
      .optional(),
    maxOveragePerCyclePaise: z.coerce
      .number()
      .int()
      .min(0)
      .nullable()
      .optional(),
    migrateAssignments: z.boolean().optional(),
    carryOverCyclePeriod: z.boolean().optional(),
  })
  .default({});

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
    permission: "programs.manage",
    canSponsor: true,
    requireActive: true,
  });
  if (access.error) return access.error;

  const raw = await req.json().catch(() => ({}));
  const parsed = SupersedeProgramBodySchema.safeParse(raw ?? {});
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body", detail: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const body = parsed.data;

  try {
    const result = await prisma.$transaction(async (tx) => {
      const old = await tx.program.findFirst({
        where: { id: programId, contract: { organizationId: orgId } },
        include: {
          licensedSeatConfig: true,
          creditPoolConfig: true,
          consultantAllowlist: true,
          assignments: {
            where: { status: "ACTIVE" },
          },
          contract: {
            select: {
              id: true,
              status: true,
              billingAccount: { select: { fundingSource: true } },
            },
          },
        },
      });

      if (!old) {
        throw Object.assign(new Error("Program not found"), {
          httpStatus: 404,
        });
      }

      if (old.status === "CANCELLED" || old.status === "EXPIRED") {
        throw Object.assign(
          new Error("Cannot supersede a cancelled or expired program"),
          { httpStatus: 409, code: "PROGRAM_ALREADY_CLOSED" },
        );
      }

      const cfg = old.licensedSeatConfig ?? old.creditPoolConfig;
      const mergedOverage = {
        overageBehavior:
          body.overageBehavior ?? cfg?.overageBehavior ?? "BLOCK",
        overageSurchargeBps:
          body.overageSurchargeBps !== undefined
            ? body.overageSurchargeBps
            : (cfg?.overageSurchargeBps ?? null),
        maxOveragePerCyclePaise:
          body.maxOveragePerCyclePaise !== undefined
            ? body.maxOveragePerCyclePaise
            : cfg?.maxOveragePerCyclePaise !== null &&
                cfg?.maxOveragePerCyclePaise !== undefined
              ? Number(cfg.maxOveragePerCyclePaise)
              : null,
        coveredEngagementsPerCycle:
          body.coveredEngagementsPerCycle !== undefined
            ? body.coveredEngagementsPerCycle
            : (old.licensedSeatConfig?.coveredEngagementsPerCycle ?? null),
      };

      const failOverage = (message: string) => {
        throw Object.assign(new Error(message), {
          httpStatus: 400,
          code: "INVALID_OVERAGE_CONFIG",
        });
      };

      if (
        old.type === "LICENSED_SEAT" &&
        (mergedOverage.coveredEngagementsPerCycle === null ||
          mergedOverage.coveredEngagementsPerCycle === undefined) &&
        (mergedOverage.overageBehavior !== "BLOCK" ||
          (mergedOverage.overageSurchargeBps ?? 0) > 0 ||
          (mergedOverage.maxOveragePerCyclePaise !== null &&
            mergedOverage.maxOveragePerCyclePaise !== undefined))
      ) {
        failOverage(
          "Overage settings have no effect while coveredEngagementsPerCycle is unlimited — clear them or set a cap.",
        );
      }

      if (
        mergedOverage.overageBehavior !== "BLOCK" &&
        ((mergedOverage.coveredEngagementsPerCycle !== null &&
          mergedOverage.coveredEngagementsPerCycle !== undefined) ||
          old.type === "CREDIT_POOL") &&
        (mergedOverage.maxOveragePerCyclePaise === null ||
          mergedOverage.maxOveragePerCyclePaise === undefined ||
          mergedOverage.maxOveragePerCyclePaise < 1)
      ) {
        failOverage(
          `overageBehavior=${mergedOverage.overageBehavior} requires a positive maxOveragePerCyclePaise circuit-breaker ceiling.`,
        );
      }

      if (
        mergedOverage.overageBehavior === "BLOCK" &&
        ((mergedOverage.overageSurchargeBps ?? 0) > 0 ||
          (mergedOverage.maxOveragePerCyclePaise !== null &&
            mergedOverage.maxOveragePerCyclePaise !== undefined))
      ) {
        failOverage(
          "overageSurchargeBps and maxOveragePerCyclePaise have no effect when overageBehavior=BLOCK — clear them or choose CHARGE_MEMBER / CHARGE_ORG.",
        );
      }

      const fundingSource = old.contract?.billingAccount?.fundingSource ?? null;
      const [overageRefusal] = overageConfigRefusals(
        fundingSource,
        mergedOverage.overageBehavior,
        mergedOverage.overageSurchargeBps,
      );
      if (overageRefusal) {
        failOverage(overageRefusal.message);
      }

      const now = new Date();

      const activeAssignments = Array.isArray(old.assignments)
        ? old.assignments
        : typeof tx.programAssignment?.findMany === "function"
          ? await tx.programAssignment.findMany({
              where: { programId: old.id, status: "ACTIVE" },
            })
          : [];

      const claimedOld = await tx.program.updateMany({
        where: {
          id: old.id,
          status: { in: ["ACTIVE", "PAUSED"] },
        },
        data: {
          status: "CANCELLED",
          archivedAt: now,
        },
      });
      if (claimedOld.count === 0) {
        throw Object.assign(
          new Error(
            "Program already superseded or closed by a concurrent request",
          ),
          { httpStatus: 409, code: "PROGRAM_ALREADY_CLOSED" },
        );
      }

      const shouldMigrateAssignments = body.migrateAssignments !== false;
      const migratedAssignmentCount = shouldMigrateAssignments
        ? activeAssignments.length
        : 0;

      const successor = await tx.program.create({
        data: {
          contractId: old.contractId,
          type: old.type,
          name: body.name ?? old.name,
          status: "ACTIVE",
          coveredPlanTypes: body.coveredPlanTypes ?? old.coveredPlanTypes,
          allowedCategories: body.allowedCategories ?? old.allowedCategories,
          configLockedAt: migratedAssignmentCount > 0 ? now : null,
        },
      });

      const nextCycle =
        body.cycle ??
        old.licensedSeatConfig?.cycle ??
        old.creditPoolConfig?.cycle ??
        "MONTHLY";

      if (old.type === "LICENSED_SEAT") {
        const oldSeat = old.licensedSeatConfig;
        await tx.licensedSeatConfig.create({
          data: {
            programId: successor.id,
            cycle: nextCycle,
            ratePerSeatPaise:
              body.ratePerSeatPaise !== undefined
                ? BigInt(body.ratePerSeatPaise)
                : (oldSeat?.ratePerSeatPaise ?? BigInt(0)),
            coveredEngagementsPerCycle:
              body.coveredEngagementsPerCycle !== undefined
                ? body.coveredEngagementsPerCycle
                : (oldSeat?.coveredEngagementsPerCycle ?? null),
            overageBehavior: mergedOverage.overageBehavior,
            overageSurchargeBps: mergedOverage.overageSurchargeBps,
            priceCapPerEngagementPaise:
              body.priceCapPerEngagementPaise !== undefined
                ? body.priceCapPerEngagementPaise !== null
                  ? BigInt(body.priceCapPerEngagementPaise)
                  : null
                : (oldSeat?.priceCapPerEngagementPaise ?? null),
            maxOveragePerCyclePaise:
              mergedOverage.maxOveragePerCyclePaise !== null
                ? BigInt(mergedOverage.maxOveragePerCyclePaise)
                : null,
            activeSeatCount: migratedAssignmentCount,
          },
        });
        if (oldSeat && typeof tx.licensedSeatConfig?.update === "function") {
          await tx.licensedSeatConfig.update({
            where: { programId: old.id },
            data: { activeSeatCount: 0 },
          });
        }
      } else if (old.type === "CREDIT_POOL") {
        const oldPool = old.creditPoolConfig;
        await tx.creditPoolConfig.create({
          data: {
            programId: successor.id,
            cycle: nextCycle,
            creditBudgetPerCycle:
              body.creditBudgetPerCycle ?? oldPool?.creditBudgetPerCycle ?? 1,
            overageBehavior: mergedOverage.overageBehavior,
            overageSurchargeBps: mergedOverage.overageSurchargeBps,
            priceCapPerEngagementPaise:
              body.priceCapPerEngagementPaise !== undefined
                ? body.priceCapPerEngagementPaise !== null
                  ? BigInt(body.priceCapPerEngagementPaise)
                  : null
                : (oldPool?.priceCapPerEngagementPaise ?? null),
            maxOveragePerCyclePaise:
              mergedOverage.maxOveragePerCyclePaise !== null
                ? BigInt(mergedOverage.maxOveragePerCyclePaise)
                : null,
          },
        });
      }

      const allowlistRows = Array.isArray(old.consultantAllowlist)
        ? old.consultantAllowlist
        : typeof tx.programConsultantAllowlist?.findMany === "function"
          ? await tx.programConsultantAllowlist.findMany({
              where: { programId: old.id },
            })
          : [];
      if (
        allowlistRows.length > 0 &&
        typeof tx.programConsultantAllowlist?.createMany === "function"
      ) {
        await tx.programConsultantAllowlist.createMany({
          data: allowlistRows.map((entry) => ({
            programId: successor.id,
            consultantProfileId: entry.consultantProfileId,
          })),
          skipDuplicates: true,
        });
      }

      if (typeof tx.programAssignment?.updateMany === "function") {
        await tx.programAssignment.updateMany({
          where: { programId: old.id, status: { in: ["ACTIVE", "PAUSED"] } },
          data: { status: "CANCELLED", periodEnd: now },
        });
      }

      if (
        shouldMigrateAssignments &&
        activeAssignments.length > 0 &&
        typeof tx.programAssignment?.create === "function"
      ) {
        const defaultPeriodEnd = computeCycleEnd(now, nextCycle);
        for (const assignment of activeAssignments) {
          const carryOver =
            body.carryOverCyclePeriod === true &&
            assignment.periodEnd > now;
          await tx.programAssignment.create({
            data: {
              programId: successor.id,
              membershipId: assignment.membershipId,
              status: "ACTIVE",
              periodStart: carryOver ? assignment.periodStart : now,
              periodEnd: carryOver ? assignment.periodEnd : defaultPeriodEnd,
              rolledFromAssignment: { connect: { id: assignment.id } },
            },
          });
        }
      }

      await tx.orgAuditLog.create({
        data: {
          organizationId: orgId,
          actorMembershipId: access.member.id,
          category: "PROGRAM",
          action: AUDIT_ACTIONS.PROGRAM.PROGRAM_SUPERSEDED,
          description: `Program ${old.id} superseded by ${successor.id}`,
          details: {
            programId: old.id,
            successorProgramId: successor.id,
            reassignedSeats: activeAssignments.length,
          },
        },
      });

      return successor;
    });

    return NextResponse.json(
      { program: result, supersededProgramId: programId },
      { status: 201 },
    );
  } catch (err) {
    if (err instanceof Error && "httpStatus" in err) {
      const status = typeof err.httpStatus === "number" ? err.httpStatus : 500;
      const code = "code" in err ? err.code : undefined;
      return NextResponse.json(
        { error: err.message, ...(code ? { code } : {}) },
        { status },
      );
    }
    Sentry.captureException(
      err instanceof Error ? err : new Error(String(err)),
      { tags: { subsystem: "enterprise" } },
    );
    throw err;
  }
}
