/**
 * Single org plan — GET / PATCH / DELETE.
 *
 *   GET    — any active member
 *   PATCH  — ORG_ADMIN+
 *   DELETE — ORG_ADMIN+ (soft delete via isActive=false)
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { ENABLE_PROVIDER_ORGS } from "@/lib/feature-flags";
import { Prisma } from "@prisma/client";

const patchPlanSchema = z.object({
  title: z.string().trim().min(2).max(120).optional(),
  description: z.string().max(2000).nullable().optional(),
  price: z.number().int().nonnegative().optional(),
  priceCurrency: z.string().length(3).optional(),
  config: z.record(z.unknown()).optional(),
  assignedConsultantIds: z.array(z.string().uuid()).optional(),
  isActive: z.boolean().optional(),
});

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ orgId: string; planId: string }> },
) {
  try {
    const { orgId, planId } = await params;
    const access = await requireOrgAccess(orgId);
    if (access.error) return access.error;

    const plan = await prisma.organizationPlan.findFirst({
      where: { id: planId, organizationProfileId: access.org.id },
    });
    if (!plan) {
      return NextResponse.json({ error: "Plan not found" }, { status: 404 });
    }
    return NextResponse.json({ plan });
  } catch (error) {
    console.error(
      "[API /organizations/[orgId]/plans/[planId] GET] error:",
      error,
    );
    return NextResponse.json(
      { error: "Failed to fetch plan" },
      { status: 500 },
    );
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string; planId: string }> },
) {
  try {
    const { orgId, planId } = await params;
    const access = await requireOrgAccess(orgId, "ORG_ADMIN");
    if (access.error) return access.error;

    const body = await req.json();
    const parsed = patchPlanSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request body", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    if (
      !ENABLE_PROVIDER_ORGS &&
      parsed.data.assignedConsultantIds &&
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

    const existing = await prisma.organizationPlan.findFirst({
      where: { id: planId, organizationProfileId: access.org.id },
      select: { id: true },
    });
    if (!existing) {
      return NextResponse.json({ error: "Plan not found" }, { status: 404 });
    }

    const { config, ...rest } = parsed.data;
    const plan = await prisma.organizationPlan.update({
      where: { id: planId },
      data: {
        ...rest,
        ...(config !== undefined && {
          config: config as Prisma.InputJsonValue,
        }),
      },
    });
    return NextResponse.json({ plan });
  } catch (error) {
    console.error(
      "[API /organizations/[orgId]/plans/[planId] PATCH] error:",
      error,
    );
    return NextResponse.json(
      { error: "Failed to update plan" },
      { status: 500 },
    );
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ orgId: string; planId: string }> },
) {
  try {
    const { orgId, planId } = await params;
    const access = await requireOrgAccess(orgId, "ORG_ADMIN");
    if (access.error) return access.error;

    const existing = await prisma.organizationPlan.findFirst({
      where: { id: planId, organizationProfileId: access.org.id },
      select: { id: true },
    });
    if (!existing) {
      return NextResponse.json({ error: "Plan not found" }, { status: 404 });
    }

    await prisma.organizationPlan.update({
      where: { id: planId },
      data: { isActive: false },
    });
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error(
      "[API /organizations/[orgId]/plans/[planId] DELETE] error:",
      error,
    );
    return NextResponse.json(
      { error: "Failed to delete plan" },
      { status: 500 },
    );
  }
}
