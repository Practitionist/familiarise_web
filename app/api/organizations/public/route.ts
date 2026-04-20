/**
 * GET /api/organizations/public
 *
 * Public (unauthenticated) listing of HOST/HYBRID organizations that have
 * opted in to marketplace discovery via Organization.isPublic=true.
 *
 * SPONSOR-only orgs (canHost=false) are never included — they are B2B clients,
 * not marketplace participants, and exposing them publicly would be a privacy
 * concern for corporate clients who want confidentiality.
 *
 * Query params:
 *   industry  — filter by org.industry (case-insensitive contains)
 *   search    — full-text search on name/description (case-insensitive)
 *   page      — 1-indexed, default 1
 *   limit     — default 12, max 50
 */

import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { apiError } from "@/lib/errors";

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = req.nextUrl;
    const page = Math.max(1, parseInt(searchParams.get("page") || "1") || 1);
    const limit = Math.min(
      Math.max(1, parseInt(searchParams.get("limit") || "12") || 12),
      50,
    );
    const industry = searchParams.get("industry")?.trim();
    const search = searchParams.get("search")?.trim();

    const skip = (page - 1) * limit;

    const where = {
      isPublic: true,
      canHost: true,
      status: "ACTIVE" as const,
      ...(industry && {
        industry: { contains: industry, mode: "insensitive" as const },
      }),
      ...(search && {
        OR: [
          { name: { contains: search, mode: "insensitive" as const } },
          { description: { contains: search, mode: "insensitive" as const } },
        ],
      }),
    };

    const [orgs, total] = await Promise.all([
      prisma.organization.findMany({
        where,
        select: {
          id: true,
          name: true,
          slug: true,
          logo: true,
          bannerImage: true,
          description: true,
          industry: true,
          website: true,
          canSponsor: true,
          canHost: true,
          _count: {
            select: {
              memberships: {
                where: { role: "EXPERT", status: "ACTIVE" },
              },
            },
          },
        },
        orderBy: { name: "asc" },
        skip,
        take: limit,
      }),
      prisma.organization.count({ where }),
    ]);

    const data = orgs.map((org) => ({
      id: org.id,
      name: org.name,
      slug: org.slug,
      logo: org.logo,
      bannerImage: org.bannerImage,
      description: org.description,
      industry: org.industry,
      website: org.website,
      capabilityKind: org.canSponsor ? "hybrid" : "host",
      expertCount: org._count.memberships,
    }));

    return NextResponse.json(
      {
        data,
        meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
      },
      {
        headers: {
          "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300",
        },
      },
    );
  } catch (error) {
    return apiError({ tag: "[Organizations.Public.GET]", error });
  }
}
