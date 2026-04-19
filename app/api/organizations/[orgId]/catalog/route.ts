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
import { requireOrgAccess, requireOrgOwner } from "@/lib/auth-helpers";

const PlanTypeSchema = z.enum([
  "CONSULTATION",
  "SUBSCRIPTION",
  "WEBINAR",
  "CLASS",
  "TRIAL",
]);

const CurrencySchema = z.enum(["INR", "USD", "EUR", "GBP"]);

const CreateBodySchema = z.object({
  planType: PlanTypeSchema,
  title: z.string().min(1).max(200),
  description: z.string().max(5000).nullable().optional(),
  price: z.coerce.number().int().min(0),
  priceCurrency: CurrencySchema.default("INR"),
  isActive: z.boolean().default(true),
  config: z.record(z.string(), z.unknown()).default({}),
  assignedConsultantIds: z.array(z.string().uuid()).default([]),
});

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
  const access = await requireOrgAccess(orgId, "MANAGER");
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
  const access = await requireOrgOwner(orgId);
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

  const plan = await prisma.organizationPlan.create({
    data: {
      organizationId: orgId,
      planType: body.planType,
      title: body.title,
      description: body.description ?? null,
      price: body.price,
      priceCurrency: body.priceCurrency,
      isActive: body.isActive,
      // Cast lives here because Prisma's JSON type is unknown-ish;
      // we've already validated shape via z.record above.
      config: body.config as object,
      assignedConsultantIds: body.assignedConsultantIds,
    },
  });

  return NextResponse.json({ plan }, { status: 201 });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const access = await requireOrgOwner(orgId);
  if (access.error) return access.error;

  const raw = await req.json().catch(() => null);
  const parsed = DeleteBodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body", detail: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { count } = await prisma.organizationPlan.updateMany({
    where: {
      organizationId: orgId,
      id: { in: parsed.data.planIds },
    },
    data: { isActive: false },
  });

  return NextResponse.json({ deactivated: count });
}
