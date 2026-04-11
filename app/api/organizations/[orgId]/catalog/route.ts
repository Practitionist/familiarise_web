/**
 * Curated plan catalog — GET / POST / DELETE.
 *
 * GET    — any active member. Lists consultant plans linked to this org.
 * POST   — ORG_ADMIN+. Links an existing plan to this org.
 * DELETE — ORG_ADMIN+. Unlinks a plan from this org.
 *
 * Uses the existing organizationProfileId FK on ConsultationPlan,
 * SubscriptionPlan, WebinarPlan, and ClassPlan tables.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";

interface CatalogItem {
  id: string;
  planType: "CONSULTATION" | "SUBSCRIPTION" | "WEBINAR" | "CLASS";
  title: string;
  price: number;
  priceCurrency: string;
  consultant: { name: string | null; image: string | null } | null;
}

const planTypeSchema = z.enum(["CONSULTATION", "SUBSCRIPTION", "WEBINAR", "CLASS"]);

const linkSchema = z.object({
  planId: z.string().min(1),
  planType: planTypeSchema,
});

async function getCatalog(orgProfileId: string): Promise<CatalogItem[]> {
  const consultantSelect = {
    select: {
      user: { select: { name: true, image: true } },
    },
  };

  const [consultations, subscriptions, webinars, classes] = await Promise.all([
    prisma.consultationPlan.findMany({
      where: { organizationProfileId: orgProfileId },
      select: {
        id: true, title: true, price: true, priceCurrency: true,
        consultantProfile: consultantSelect,
      },
    }),
    prisma.subscriptionPlan.findMany({
      where: { organizationProfileId: orgProfileId },
      select: {
        id: true, title: true, price: true, priceCurrency: true,
        consultantProfile: consultantSelect,
      },
    }),
    prisma.webinarPlan.findMany({
      where: { organizationProfileId: orgProfileId },
      select: {
        id: true, title: true, price: true, priceCurrency: true,
        consultantProfile: consultantSelect,
      },
    }),
    prisma.classPlan.findMany({
      where: { organizationProfileId: orgProfileId },
      select: {
        id: true, title: true, price: true, priceCurrency: true,
        consultantProfile: consultantSelect,
      },
    }),
  ]);

  const items: CatalogItem[] = [];
  for (const p of consultations)
    items.push({ ...p, planType: "CONSULTATION", consultant: p.consultantProfile?.user ?? null });
  for (const p of subscriptions)
    items.push({ ...p, planType: "SUBSCRIPTION", consultant: p.consultantProfile?.user ?? null });
  for (const p of webinars)
    items.push({ ...p, planType: "WEBINAR", consultant: p.consultantProfile?.user ?? null });
  for (const p of classes)
    items.push({ ...p, planType: "CLASS", consultant: p.consultantProfile?.user ?? null });

  return items;
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  try {
    const { orgId } = await params;
    const access = await requireOrgAccess(orgId);
    if (access.error) return access.error;

    const catalog = await getCatalog(access.org.id);
    return NextResponse.json({ catalog });
  } catch (error) {
    console.error("[API /catalog GET] error:", error);
    return NextResponse.json({ error: "Failed to fetch catalog" }, { status: 500 });
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
    const parsed = linkSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const { planId, planType } = parsed.data;
    const data = { organizationProfileId: access.org.id };

    switch (planType) {
      case "CONSULTATION":
        await prisma.consultationPlan.update({ where: { id: planId }, data });
        break;
      case "SUBSCRIPTION":
        await prisma.subscriptionPlan.update({ where: { id: planId }, data });
        break;
      case "WEBINAR":
        await prisma.webinarPlan.update({ where: { id: planId }, data });
        break;
      case "CLASS":
        await prisma.classPlan.update({ where: { id: planId }, data });
        break;
    }

    return NextResponse.json({ success: true }, { status: 201 });
  } catch (error) {
    console.error("[API /catalog POST] error:", error);
    return NextResponse.json({ error: "Failed to link plan" }, { status: 500 });
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  try {
    const { orgId } = await params;
    const access = await requireOrgAccess(orgId, "ORG_ADMIN");
    if (access.error) return access.error;

    const body = await req.json();
    const parsed = linkSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const { planId, planType } = parsed.data;
    const data = { organizationProfileId: null };

    switch (planType) {
      case "CONSULTATION":
        await prisma.consultationPlan.update({ where: { id: planId }, data });
        break;
      case "SUBSCRIPTION":
        await prisma.subscriptionPlan.update({ where: { id: planId }, data });
        break;
      case "WEBINAR":
        await prisma.webinarPlan.update({ where: { id: planId }, data });
        break;
      case "CLASS":
        await prisma.classPlan.update({ where: { id: planId }, data });
        break;
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[API /catalog DELETE] error:", error);
    return NextResponse.json({ error: "Failed to unlink plan" }, { status: 500 });
  }
}
