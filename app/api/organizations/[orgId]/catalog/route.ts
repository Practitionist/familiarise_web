/**
 * GET    /api/organizations/[orgId]/catalog
 * POST   /api/organizations/[orgId]/catalog
 * DELETE /api/organizations/[orgId]/catalog
 *
 * Org-curated plan catalog. An OrganizationPlan is a sponsored plan
 * offering that the org pre-selects on behalf of its members — a subset
 * of the public marketplace catalog with optional consultant assignments.
 *
 * DELETE at the collection endpoint is a bulk deactivate; per-plan
 * detail + update lives under /plans/[planId] (managed by the existing
 * plans route family, untouched here).
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";

const PlanTypeSchema = z.enum([
  "CONSULTATION",
  "SUBSCRIPTION",
  "WEBINAR",
  "CLASS",
  "TRIAL",
]);

const CurrencySchema = z.enum(["INR", "USD", "EUR", "GBP"]);

// #768 lockdown #28 — typed per-type configs (was z.record Json blob).
// Each branch maps 1:1 to its OrgXxxPlanConfig child model.
const ConsultationConfig = z.object({
  durationInHours: z.coerce.number().positive(),
  preReadingNotes: z.string().max(2000).nullable().optional(),
});
const SubscriptionConfig = z.object({
  durationInMonths: z.coerce.number().int().positive(),
  callsPerWeek: z.coerce.number().int().positive(),
  sessionDurationInHours: z.coerce.number().positive(),
  totalSessions: z.coerce.number().int().positive(),
});
const WebinarConfig = z.object({
  durationInHours: z.coerce.number().positive(),
  maxParticipants: z.coerce.number().int().positive(),
  publicRegistrationAllowed: z.boolean().default(false),
});
const ClassConfig = z.object({
  durationInMonths: z.coerce.number().int().positive(),
  meetingsPerWeek: z.coerce.number().int().positive(),
  sessionDurationInHours: z.coerce.number().positive(),
  totalSessions: z.coerce.number().int().positive(),
  maxParticipants: z.coerce.number().int().positive(),
});

const CreateBodySchema = z.discriminatedUnion("planType", [
  z.object({
    planType: z.literal("CONSULTATION"),
    title: z.string().min(1).max(200),
    description: z.string().max(5000).nullable().optional(),
    price: z.coerce.number().int().min(0),
    priceCurrency: CurrencySchema.default("INR"),
    isActive: z.boolean().default(true),
    config: ConsultationConfig,
    assignedConsultantIds: z.array(z.string().uuid()).default([]),
  }),
  z.object({
    planType: z.literal("SUBSCRIPTION"),
    title: z.string().min(1).max(200),
    description: z.string().max(5000).nullable().optional(),
    price: z.coerce.number().int().min(0),
    priceCurrency: CurrencySchema.default("INR"),
    isActive: z.boolean().default(true),
    config: SubscriptionConfig,
    assignedConsultantIds: z.array(z.string().uuid()).default([]),
  }),
  z.object({
    planType: z.literal("WEBINAR"),
    title: z.string().min(1).max(200),
    description: z.string().max(5000).nullable().optional(),
    price: z.coerce.number().int().min(0),
    priceCurrency: CurrencySchema.default("INR"),
    isActive: z.boolean().default(true),
    config: WebinarConfig,
    assignedConsultantIds: z.array(z.string().uuid()).default([]),
  }),
  z.object({
    planType: z.literal("CLASS"),
    title: z.string().min(1).max(200),
    description: z.string().max(5000).nullable().optional(),
    price: z.coerce.number().int().min(0),
    priceCurrency: CurrencySchema.default("INR"),
    isActive: z.boolean().default(true),
    config: ClassConfig,
    assignedConsultantIds: z.array(z.string().uuid()).default([]),
  }),
]);

const QuerySchema = z.object({
  planType: PlanTypeSchema.optional(),
  active: z.enum(["true", "false"]).optional(),
});

const DeleteBodySchema = z.object({
  planIds: z.array(z.string().uuid()).min(1).max(100),
});

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const access = await requireOrgAccess(orgId, { minimumRole: "MANAGER", canSponsor: true });
  if (access.error) return access.error;

  const url = new URL(req.url);
  const parsedQuery = QuerySchema.safeParse(
    Object.fromEntries(url.searchParams.entries()),
  );
  if (!parsedQuery.success) {
    return NextResponse.json(
      { error: "Invalid query", detail: parsedQuery.error.flatten() },
      { status: 400 },
    );
  }
  const q = parsedQuery.data;

  const plans = await prisma.organizationPlan.findMany({
    where: {
      organizationId: orgId,
      ...(q.planType && { planType: q.planType }),
      ...(q.active === "true" && { isActive: true }),
      ...(q.active === "false" && { isActive: false }),
    },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json({ data: plans });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const access = await requireOrgAccess(orgId, { minimumRole: "OWNER", canSponsor: true });
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

  const plan = await prisma.$transaction(async (tx) => {
    const created = await tx.organizationPlan.create({
      data: {
        organizationId: orgId,
        planType: body.planType,
        title: body.title,
        description: body.description ?? null,
        price: body.price,
        priceCurrency: body.priceCurrency,
        isActive: body.isActive,
        assignedConsultantIds: body.assignedConsultantIds,
        // #768 lockdown #28 — typed per-type child config.
        ...(body.planType === "CONSULTATION" && {
          consultationConfig: { create: body.config },
        }),
        ...(body.planType === "SUBSCRIPTION" && {
          subscriptionConfig: { create: body.config },
        }),
        ...(body.planType === "WEBINAR" && {
          webinarConfig: { create: body.config },
        }),
        ...(body.planType === "CLASS" && {
          classConfig: { create: body.config },
        }),
      },
    });

    await tx.orgAuditLog.create({
      data: {
        organizationId: orgId,
        actorMembershipId: access.member.id,
        category: "CATALOG",
        action: AUDIT_ACTIONS.CATALOG.CATALOG_PLAN_CREATED,
        description: `Plan added to catalog: ${created.title}`,
        details: {
          planId: created.id,
          planType: created.planType,
          pricePaise: created.price,
          currency: created.priceCurrency,
        },
      },
    });

    return created;
  });

  return NextResponse.json({ plan }, { status: 201 });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const access = await requireOrgAccess(orgId, { minimumRole: "OWNER", canSponsor: true });
  if (access.error) return access.error;

  const raw = await req.json().catch(() => null);
  const parsed = DeleteBodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body", detail: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { count } = await prisma.$transaction(async (tx) => {
    const updated = await tx.organizationPlan.updateMany({
      where: {
        organizationId: orgId,
        id: { in: parsed.data.planIds },
      },
      data: { isActive: false },
    });

    if (updated.count > 0) {
      await tx.orgAuditLog.create({
        data: {
          organizationId: orgId,
          actorMembershipId: access.member.id,
          category: "CATALOG",
          action: AUDIT_ACTIONS.CATALOG.CATALOG_PLAN_DEACTIVATED,
          description: `Deactivated ${updated.count} catalog plan(s)`,
          details: {
            planIds: parsed.data.planIds,
            deactivated: updated.count,
          },
        },
      });
    }

    return updated;
  });

  return NextResponse.json({ deactivated: count });
}
