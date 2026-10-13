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
import { Prisma } from "@prisma/client";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { computeCycleEnd } from "@/lib/enterprise/cycle-engine";
import { assertMergedOverageConfigValid } from "@/lib/enterprise/reachable-paths";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";
import { dispatchWebhookEvent } from "@/lib/enterprise/outbound-webhooks/dispatch";
import { releaseSeatsForClosedAssignments } from "@/lib/api/organizations/seat-count";
import { withSerializableRetry } from "@/lib/db/serializable-retry";

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
      .positive()
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

type SupersedeBody = z.infer<typeof SupersedeProgramBodySchema>;
type TxClient = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

function resolvePriceCapBigInt(
  bodyPriceCap: number | null | undefined,
  fallbackPriceCap: bigint | number | null | undefined,
): bigint | null {
  if (bodyPriceCap !== undefined) {
    return bodyPriceCap === null ? null : BigInt(bodyPriceCap);
  }
  if (fallbackPriceCap === null || fallbackPriceCap === undefined) {
    return null;
  }
  return BigInt(fallbackPriceCap);
}

function resolveMaxOverageNumber(
  bodyMaxOverage: number | null | undefined,
  cfgMaxOverage: bigint | number | null | undefined,
): number | null {
  if (bodyMaxOverage !== undefined) {
    return bodyMaxOverage;
  }
  if (cfgMaxOverage === null || cfgMaxOverage === undefined) {
    return null;
  }
  return Number(cfgMaxOverage);
}

function resolveAssignmentUserId(
  created: { membership?: { userId?: string } } & Record<string, unknown>,
  sourceAssignment: { membership?: { userId?: string } } & Record<
    string,
    unknown
  >,
): string | undefined {
  if (typeof created.membership?.userId === "string") {
    return created.membership.userId;
  }
  if (typeof created.userId === "string") {
    return created.userId;
  }
  if (typeof sourceAssignment.membership?.userId === "string") {
    return sourceAssignment.membership.userId;
  }
  if (typeof sourceAssignment.userId === "string") {
    return sourceAssignment.userId;
  }
  return undefined;
}

async function createSuccessorProgramConfig(args: {
  tx: TxClient;
  successorId: string;
  old: {
    type: "LICENSED_SEAT" | "CREDIT_POOL";
    licensedSeatConfig: {
      ratePerSeatPaise: bigint | number;
      coveredEngagementsPerCycle: number | null;
      priceCapPerEngagementPaise: bigint | number | null;
    } | null;
    creditPoolConfig: {
      creditBudgetPerCycle: number;
      priceCapPerEngagementPaise: bigint | number | null;
    } | null;
  };
  body: SupersedeBody;
  nextCycle: "MONTHLY" | "QUARTERLY" | "ANNUAL";
  mergedOverage: {
    overageBehavior: "BLOCK" | "CHARGE_MEMBER" | "CHARGE_ORG";
    overageSurchargeBps: number | null;
    maxOveragePerCyclePaise: number | null;
  };
  migratedAssignmentCount: number;
}): Promise<void> {
  const {
    tx,
    successorId,
    old,
    body,
    nextCycle,
    mergedOverage,
    migratedAssignmentCount,
  } = args;
  const maxOverageBigInt =
    mergedOverage.maxOveragePerCyclePaise !== null
      ? BigInt(mergedOverage.maxOveragePerCyclePaise)
      : null;

  if (old.type === "LICENSED_SEAT") {
    const oldSeat = old.licensedSeatConfig;
    await tx.licensedSeatConfig.create({
      data: {
        programId: successorId,
        cycle: nextCycle,
        ratePerSeatPaise:
          body.ratePerSeatPaise !== undefined
            ? BigInt(body.ratePerSeatPaise)
            : BigInt(oldSeat?.ratePerSeatPaise ?? 0),
        coveredEngagementsPerCycle:
          body.coveredEngagementsPerCycle !== undefined
            ? body.coveredEngagementsPerCycle
            : (oldSeat?.coveredEngagementsPerCycle ?? null),
        overageBehavior: mergedOverage.overageBehavior,
        overageSurchargeBps: mergedOverage.overageSurchargeBps,
        priceCapPerEngagementPaise: resolvePriceCapBigInt(
          body.priceCapPerEngagementPaise,
          oldSeat?.priceCapPerEngagementPaise,
        ),
        maxOveragePerCyclePaise: maxOverageBigInt,
        activeSeatCount: migratedAssignmentCount,
      },
    });
    return;
  }

  const oldPool = old.creditPoolConfig;
  await tx.creditPoolConfig.create({
    data: {
      programId: successorId,
      cycle: nextCycle,
      creditBudgetPerCycle:
        body.creditBudgetPerCycle ?? oldPool?.creditBudgetPerCycle ?? 1,
      overageBehavior: mergedOverage.overageBehavior,
      overageSurchargeBps: mergedOverage.overageSurchargeBps,
      priceCapPerEngagementPaise: resolvePriceCapBigInt(
        body.priceCapPerEngagementPaise,
        oldPool?.priceCapPerEngagementPaise,
      ),
      maxOveragePerCyclePaise: maxOverageBigInt,
    },
  });
}

async function migrateAssignmentsToSuccessor(args: {
  tx: TxClient;
  orgId: string;
  successorId: string;
  activeAssignments: Array<{
    id: string;
    membershipId: string;
    periodStart: Date;
    periodEnd: Date;
    engagementsUsed?: number;
    consumedPaise?: bigint | number;
    membership?: { userId?: string };
    userId?: string;
  }>;
  carryOverCyclePeriod: boolean | undefined;
  now: Date;
  nextCycle: "MONTHLY" | "QUARTERLY" | "ANNUAL";
}): Promise<void> {
  const { tx, orgId, successorId, activeAssignments, now, nextCycle } = args;
  const defaultPeriodEnd = computeCycleEnd(now, nextCycle);

  for (const assignment of activeAssignments) {
    const carryOver =
      args.carryOverCyclePeriod !== false && assignment.periodEnd > now;
    const created = await tx.programAssignment.create({
      data: {
        programId: successorId,
        membershipId: assignment.membershipId,
        status: "ACTIVE",
        periodStart: carryOver ? assignment.periodStart : now,
        periodEnd: carryOver ? assignment.periodEnd : defaultPeriodEnd,
        engagementsUsed: carryOver ? (assignment.engagementsUsed ?? 0) : 0,
        consumedPaise: carryOver
          ? BigInt(assignment.consumedPaise ?? 0)
          : BigInt(0),
        rolledFromAssignment: { connect: { id: assignment.id } },
      },
      include: { membership: { select: { userId: true } } },
    });

    await dispatchWebhookEvent({
      prisma: tx,
      organizationId: orgId,
      eventType: "program.assigned",
      payload: {
        assignmentId: created.id,
        programId: successorId,
        membershipId: created.membershipId,
        userId: resolveAssignmentUserId(created, assignment),
        source: "program_supersede",
      },
    });
  }
}

async function loadActiveAssignmentsForSupersede(
  tx: TxClient,
  old: {
    id: string;
    assignments?: Array<{
      id: string;
      membershipId: string;
      periodStart: Date;
      periodEnd: Date;
      engagementsUsed?: number;
      consumedPaise?: bigint | number;
      membership?: { userId?: string };
    }>;
  },
  now: Date,
) {
  if (Array.isArray(old.assignments)) {
    return old.assignments.filter((a) => !a.periodEnd || a.periodEnd >= now);
  }
  if (typeof tx.programAssignment?.findMany === "function") {
    return tx.programAssignment.findMany({
      where: {
        programId: old.id,
        status: "ACTIVE",
        periodEnd: { gte: now },
      },
      include: { membership: { select: { userId: true } } },
    });
  }
  return [];
}

async function copyConsultantAllowlistToSuccessor(
  tx: TxClient,
  old: {
    id: string;
    consultantAllowlist?: Array<{ consultantProfileId: string }>;
  },
  successorId: string,
): Promise<void> {
  let allowlistRows: Array<{ consultantProfileId: string }> = [];
  if (Array.isArray(old.consultantAllowlist)) {
    allowlistRows = old.consultantAllowlist;
  } else if (typeof tx.programConsultantAllowlist?.findMany === "function") {
    allowlistRows = await tx.programConsultantAllowlist.findMany({
      where: { programId: old.id },
    });
  }

  if (
    allowlistRows.length > 0 &&
    typeof tx.programConsultantAllowlist?.createMany === "function"
  ) {
    await tx.programConsultantAllowlist.createMany({
      data: allowlistRows.map((entry) => ({
        programId: successorId,
        consultantProfileId: entry.consultantProfileId,
      })),
      skipDuplicates: true,
    });
  }
}

async function closeOldProgramSeatsAndBalanceSubscription(args: {
  tx: TxClient;
  old: {
    id: string;
    type: "LICENSED_SEAT" | "CREDIT_POOL";
    licensedSeatConfig: unknown;
  };
  initialActiveCount: number;
  migratedAssignmentCount: number;
  now: Date;
}): Promise<void> {
  const { tx, old, initialActiveCount, migratedAssignmentCount, now } = args;
  let closedSeatCount = initialActiveCount;
  if (typeof tx.programAssignment?.updateMany === "function") {
    const closedActive = await tx.programAssignment.updateMany({
      where: { programId: old.id, status: "ACTIVE" },
      data: { status: "CANCELLED", periodEnd: now },
    });
    if (typeof closedActive?.count === "number") {
      closedSeatCount = closedActive.count;
    }
    await tx.programAssignment.updateMany({
      where: { programId: old.id, status: "PAUSED" },
      data: { status: "CANCELLED", periodEnd: now },
    });
  }

  const netReleasedSeats = Math.max(
    0,
    closedSeatCount - migratedAssignmentCount,
  );
  if (netReleasedSeats > 0 && typeof tx.program?.findUnique === "function") {
    await releaseSeatsForClosedAssignments(tx, old.id, netReleasedSeats);
  }

  if (
    old.type === "LICENSED_SEAT" &&
    Boolean(old.licensedSeatConfig) &&
    typeof tx.licensedSeatConfig?.update === "function"
  ) {
    await tx.licensedSeatConfig.update({
      where: { programId: old.id },
      data: { activeSeatCount: 0 },
    });
  }
}

async function executeProgramSupersedeTx(
  tx: TxClient,
  args: {
    orgId: string;
    programId: string;
    actorMembershipId: string;
    body: SupersedeBody;
  },
) {
  const { orgId, programId, actorMembershipId, body } = args;
  const now = new Date();
  const old = await tx.program.findFirst({
    where: { id: programId, contract: { organizationId: orgId } },
    include: {
      licensedSeatConfig: true,
      creditPoolConfig: true,
      consultantAllowlist: true,
      assignments: {
        where: { status: "ACTIVE", periodEnd: { gte: now } },
        include: { membership: { select: { userId: true } } },
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
    overageBehavior: body.overageBehavior ?? cfg?.overageBehavior ?? "BLOCK",
    overageSurchargeBps:
      body.overageSurchargeBps !== undefined
        ? body.overageSurchargeBps
        : (cfg?.overageSurchargeBps ?? null),
    maxOveragePerCyclePaise: resolveMaxOverageNumber(
      body.maxOveragePerCyclePaise,
      cfg?.maxOveragePerCyclePaise,
    ),
    coveredEngagementsPerCycle:
      body.coveredEngagementsPerCycle !== undefined
        ? body.coveredEngagementsPerCycle
        : (old.licensedSeatConfig?.coveredEngagementsPerCycle ?? null),
  };

  assertMergedOverageConfigValid({
    programType: old.type,
    fundingSource: old.contract?.billingAccount?.fundingSource ?? null,
    overageBehavior: mergedOverage.overageBehavior,
    overageSurchargeBps: mergedOverage.overageSurchargeBps,
    maxOveragePerCyclePaise: mergedOverage.maxOveragePerCyclePaise,
    coveredEngagementsPerCycle: mergedOverage.coveredEngagementsPerCycle,
    disallowMaxOverageWhenBlocked: true,
  });

  const activeAssignments = await loadActiveAssignmentsForSupersede(
    tx,
    old,
    now,
  );

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
      new Error("Program already superseded or closed by a concurrent request"),
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

  await createSuccessorProgramConfig({
    tx,
    successorId: successor.id,
    old,
    body,
    nextCycle,
    mergedOverage,
    migratedAssignmentCount,
  });

  await copyConsultantAllowlistToSuccessor(tx, old, successor.id);

  await closeOldProgramSeatsAndBalanceSubscription({
    tx,
    old,
    initialActiveCount: activeAssignments.length,
    migratedAssignmentCount,
    now,
  });

  if (
    shouldMigrateAssignments &&
    activeAssignments.length > 0 &&
    typeof tx.programAssignment?.create === "function"
  ) {
    await migrateAssignmentsToSuccessor({
      tx,
      orgId,
      successorId: successor.id,
      activeAssignments,
      carryOverCyclePeriod: body.carryOverCyclePeriod,
      now,
      nextCycle,
    });
  }

  await tx.orgAuditLog.create({
    data: {
      organizationId: orgId,
      actorMembershipId,
      category: "PROGRAM",
      action: AUDIT_ACTIONS.PROGRAM.PROGRAM_SUPERSEDED,
      description: `Program ${old.id} superseded by ${successor.id}`,
      details: {
        programId: old.id,
        successorProgramId: successor.id,
        reassignedSeats: migratedAssignmentCount,
      },
    },
  });

  return successor;
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
    const result = await withSerializableRetry(() =>
      prisma.$transaction(
        (tx) =>
          executeProgramSupersedeTx(tx, {
            orgId,
            programId,
            actorMembershipId: access.member.id,
            body,
          }),
        {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          maxWait: 10_000,
          timeout: 15_000,
        },
      ),
    );

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
