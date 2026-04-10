/**
 * Org-owned catalog plans (OrganizationPlan).
 *
 * GET  — any active member; lists active plans
 * POST — ORG_ADMIN+; creates a new plan template
 *
 * `assignedConsultantIds` is feature-flagged: a non-empty assignment is
 * PROVIDER-only because it implies the org is fanning bookings out to
 * specific consultants under its umbrella.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { ENABLE_PROVIDER_ORGS } from "@/lib/feature-flags";
import { AppointmentsType, Prisma } from "@prisma/client";

const createPlanSchema = z.object({
  planType: z.nativeEnum(AppointmentsType),
  title: z.string().trim().min(2).max(120),
  description: z.string().max(2000).optional(),
  price: z.number().int().nonnegative(), // in paise
  priceCurrency: z.string().length(3).default("INR"),
  config: z.record(z.unknown()).default({}),
  assignedConsultantIds: z.array(z.string().uuid()).default([]),
  isActive: z.boolean().default(true),
});

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  try {
    const { orgId } = await params;
    const access = await requireOrgAccess(orgId);
    if (access.error) return access.error;

    const plans = await prisma.organizationPlan.findMany({
      where: { organizationProfileId: access.org.id },
      orderBy: { createdAt: "desc" },
    });
    return NextResponse.json({ plans });
  } catch (error) {
    console.error("[API /organizations/[orgId]/plans GET] error:", error);
    return NextResponse.json(
      { error: "Failed to fetch plans" },
      { status: 500 },
    );
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  try {
    const { orgId } = await params;
    const access = await requireOrgAccess(orgId, "ORG_ADMIN");
    if (access.error) return access.error;

    const body = await req.json();
    const parsed = createPlanSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request body", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    if (
      !ENABLE_PROVIDER_ORGS &&
      parsed.data.assignedConsultantIds.length > 0
    ) {
      return NextResponse.json(
        {
          error:
            "Per-consultant plan assignment is gated behind PROVIDER orgs.",
          flag: "ENABLE_PROVIDER_ORGS",
        },
        { status: 501 },
      );
    }

    const plan = await prisma.organizationPlan.create({
      data: {
        organizationProfileId: access.org.id,
        ...parsed.data,
        config: parsed.data.config as Prisma.InputJsonValue,
      },
    });

    return NextResponse.json({ plan }, { status: 201 });
  } catch (error) {
    console.error("[API /organizations/[orgId]/plans POST] error:", error);
    return NextResponse.json(
      { error: "Failed to create plan" },
      { status: 500 },
    );
  }
}
