/**
 * GET  /api/organizations/[orgId]/programs
 * POST /api/organizations/[orgId]/programs
 *
 * Programs are the commercial primitive — every ProgramAssignment hangs
 * off one. v1 supports LICENSED_SEAT and CREDIT_POOL; PROJECT and
 * RETAINER are reserved in the Prisma enum for v2 but not yet accepted
 * at the create endpoint. See schema.prisma for the full subtype story.
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";

const CoveredPlanTypeSchema = z.enum([
  "CONSULTATION",
  "CLASS",
  "WEBINAR",
  "SUBSCRIPTION",
]);

const BillingCycleSchema = z.enum(["MONTHLY", "QUARTERLY", "ANNUAL"]);
const OverageBehaviorSchema = z.enum(["BLOCK", "CHARGE_MEMBER", "CHARGE_ORG"]);

// Create bodies are discriminated by `type` so the nested config schema
// only accepts the right shape for each subtype. A LICENSED_SEAT body
// with creditPoolConfig fails validation at the edge, not at the DB.
const LicensedSeatConfigSchema = z.object({
  ratePerSeatPaise: z.coerce.number().int().min(0),
  cycle: BillingCycleSchema,
  coveredSessionsPerCycle: z.coerce.number().int().min(0).nullable().optional(),
  overageBehavior: OverageBehaviorSchema.default("BLOCK"),
  priceCapPerSessionPaise: z.coerce.number().int().min(0).nullable().optional(),
});

// 1 credit = ₹1 = 100 paise (fixed; see schema.prisma). The pool resets
// every `cycle`. Premium-tier multipliers were dropped from v1 — bespoke
// per-expert rates live on a Program rate-card override.
const CreditPoolConfigSchema = z.object({
  cycle: BillingCycleSchema,
  creditsPerCycle: z.coerce.number().int().min(1),
  minimumCreditsPerPeriod: z.coerce.number().int().min(0).nullable().optional(),
});

const CreateBodySchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("LICENSED_SEAT"),
    contractId: z.string().min(1),
    name: z.string().min(2).max(120),
    coveredPlanTypes: z.array(CoveredPlanTypeSchema).default([]),
    allowedCategories: z.array(z.string()).default([]),
    licensedSeatConfig: LicensedSeatConfigSchema,
  }),
  z.object({
    type: z.literal("CREDIT_POOL"),
    contractId: z.string().min(1),
    name: z.string().min(2).max(120),
    coveredPlanTypes: z.array(CoveredPlanTypeSchema).default([]),
    allowedCategories: z.array(z.string()).default([]),
    creditPoolConfig: CreditPoolConfigSchema,
  }),
]);

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  // Read is widened to any ACTIVE org member: LEARNERs legitimately need
  // to see "which programs am I under" (drives the home dashboard,
  // booking UI, and utilization widgets). Mutations (POST below) stay
  // MANAGER+canSponsor — see docs/enterprise/02-roles-and-access.md.
  const access = await requireOrgAccess(orgId);
  if (access.error) return access.error;
  if (!access.org.canSponsor) {
    // Hosting-only orgs genuinely do not have programs; surface 404 so
    // the nav treats this as "feature off" rather than "forbidden".
    return NextResponse.json(
      { error: "Organization does not sponsor — no programs to list" },
      { status: 404 },
    );
  }

  const url = new URL(req.url);
  const contractId = url.searchParams.get("contractId") ?? undefined;

  const programs = await prisma.program.findMany({
    where: {
      contract: { organizationId: orgId },
      ...(contractId && { contractId }),
    },
    include: {
      licensedSeatConfig: true,
      creditPoolConfig: true,
      _count: { select: { assignments: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json({ data: programs });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
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

  // Contract ownership check — same pattern as BillingAccount in
  // /contracts: reject a stolen id from another tenant before we hit
  // the FK layer with a 500.
  const contract = await prisma.contract.findUnique({
    where: { id: body.contractId },
    select: { organizationId: true, status: true },
  });
  if (!contract || contract.organizationId !== orgId) {
    return NextResponse.json(
      { error: "Contract does not belong to this organization" },
      { status: 400 },
    );
  }
  if (contract.status === "TERMINATED" || contract.status === "EXPIRED") {
    return NextResponse.json(
      { error: `Cannot attach a program to a ${contract.status} contract` },
      { status: 409 },
    );
  }

  const program = await prisma.$transaction(async (tx) => {
    const created = await tx.program.create({
      data: {
        contractId: body.contractId,
        type: body.type,
        name: body.name,
        coveredPlanTypes: body.coveredPlanTypes,
        allowedCategories: body.allowedCategories,
        ...(body.type === "LICENSED_SEAT" && {
          licensedSeatConfig: {
            create: {
              ratePerSeatPaise: body.licensedSeatConfig.ratePerSeatPaise,
              cycle: body.licensedSeatConfig.cycle,
              coveredSessionsPerCycle:
                body.licensedSeatConfig.coveredSessionsPerCycle ?? null,
              overageBehavior: body.licensedSeatConfig.overageBehavior,
              priceCapPerSessionPaise:
                body.licensedSeatConfig.priceCapPerSessionPaise ?? null,
            },
          },
        }),
        ...(body.type === "CREDIT_POOL" && {
          creditPoolConfig: {
            create: {
              cycle: body.creditPoolConfig.cycle,
              creditsPerCycle: body.creditPoolConfig.creditsPerCycle,
              minimumCreditsPerPeriod:
                body.creditPoolConfig.minimumCreditsPerPeriod ?? null,
            },
          },
        }),
      },
      include: {
        licensedSeatConfig: true,
        creditPoolConfig: true,
      },
    });

    await tx.orgAuditLog.create({
      data: {
        organizationId: orgId,
        actorMembershipId: access.member.id,
        category: "PROGRAM",
        action: AUDIT_ACTIONS.PROGRAM.PROGRAM_CREATED,
        description: `Program ${created.name} (${created.type}) created under contract ${body.contractId}`,
        details: {
          programId: created.id,
          contractId: body.contractId,
          type: body.type,
        },
      },
    });

    return created;
  });

  return NextResponse.json({ program }, { status: 201 });
}
