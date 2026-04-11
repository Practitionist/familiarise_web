/**
 * Search public consultant plans for the org catalog browse modal.
 *
 * GET — ORG_ADMIN+. Returns plans from verified consultants that are
 * not already linked to any org. Searches across all 4 plan tables.
 */

import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";

interface SearchResult {
  id: string;
  planType: "CONSULTATION" | "SUBSCRIPTION" | "WEBINAR" | "CLASS";
  title: string;
  price: number;
  priceCurrency: string;
  consultant: { name: string | null; image: string | null };
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  try {
    const { orgId } = await params;
    const access = await requireOrgAccess(orgId, "ORG_ADMIN");
    if (access.error) return access.error;

    const url = new URL(req.url);
    const search = url.searchParams.get("search")?.trim() ?? "";
    const planType = url.searchParams.get("planType");
    const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "10"), 30);

    const searchFilter = search
      ? { title: { contains: search, mode: "insensitive" as const } }
      : {};

    const baseWhere = {
      organizationProfileId: null, // not already linked to any org
      consultantProfile: { isVerified: true },
      ...searchFilter,
    };

    const consultantSelect = {
      select: { user: { select: { name: true, image: true } } },
    };

    const results: SearchResult[] = [];

    // Query each plan table in parallel (or filtered by planType)
    const queries = [];

    if (!planType || planType === "CONSULTATION") {
      queries.push(
        prisma.consultationPlan.findMany({
          where: baseWhere,
          select: {
            id: true, title: true, price: true, priceCurrency: true,
            consultantProfile: consultantSelect,
          },
          take: limit,
          orderBy: { createdAt: "desc" },
        }).then((plans) =>
          plans.forEach((p) =>
            results.push({
              ...p,
              planType: "CONSULTATION",
              consultant: p.consultantProfile?.user ?? { name: null, image: null },
            }),
          ),
        ),
      );
    }

    if (!planType || planType === "SUBSCRIPTION") {
      queries.push(
        prisma.subscriptionPlan.findMany({
          where: baseWhere,
          select: {
            id: true, title: true, price: true, priceCurrency: true,
            consultantProfile: consultantSelect,
          },
          take: limit,
          orderBy: { createdAt: "desc" },
        }).then((plans) =>
          plans.forEach((p) =>
            results.push({
              ...p,
              planType: "SUBSCRIPTION",
              consultant: p.consultantProfile?.user ?? { name: null, image: null },
            }),
          ),
        ),
      );
    }

    if (!planType || planType === "WEBINAR") {
      queries.push(
        prisma.webinarPlan.findMany({
          where: baseWhere,
          select: {
            id: true, title: true, price: true, priceCurrency: true,
            consultantProfile: consultantSelect,
          },
          take: limit,
          orderBy: { createdAt: "desc" },
        }).then((plans) =>
          plans.forEach((p) =>
            results.push({
              ...p,
              planType: "WEBINAR",
              consultant: p.consultantProfile?.user ?? { name: null, image: null },
            }),
          ),
        ),
      );
    }

    if (!planType || planType === "CLASS") {
      queries.push(
        prisma.classPlan.findMany({
          where: baseWhere,
          select: {
            id: true, title: true, price: true, priceCurrency: true,
            consultantProfile: consultantSelect,
          },
          take: limit,
          orderBy: { createdAt: "desc" },
        }).then((plans) =>
          plans.forEach((p) =>
            results.push({
              ...p,
              planType: "CLASS",
              consultant: p.consultantProfile?.user ?? { name: null, image: null },
            }),
          ),
        ),
      );
    }

    await Promise.all(queries);

    // Sort by title, take top N across all types
    results.sort((a, b) => a.title.localeCompare(b.title));

    return NextResponse.json({ results: results.slice(0, limit) });
  } catch (error) {
    console.error("[API /catalog/search GET] error:", error);
    return NextResponse.json({ error: "Failed to search plans" }, { status: 500 });
  }
}
