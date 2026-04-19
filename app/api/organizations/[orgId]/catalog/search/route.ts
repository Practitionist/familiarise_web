/**
 * GET /api/organizations/[orgId]/catalog/search
 *
 * Text-search over the org's curated catalog. Matches `title`,
 * `description`, and plan config values. Returns a thin projection
 * optimized for the member-facing picker (no internal ids or
 * consultant-assignment lists).
 *
 * This is intentionally a shallow search — no ranking, no fuzzy
 * matching. The catalog is small (tens-to-hundreds of plans per org),
 * so Postgres ILIKE on title+description is sufficient. If catalogs
 * grow past ~5k plans, wire it to the existing Typesense index via
 * the public catalog search path.
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";

const PlanTypeSchema = z.enum([
  "CONSULTATION",
  "SUBSCRIPTION",
  "WEBINAR",
  "CLASS",
  "TRIAL",
]);

const QuerySchema = z.object({
  q: z.string().min(1).max(200),
  planType: PlanTypeSchema.optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  // Members (LEARNER+) can search their own org's catalog.
  const access = await requireOrgAccess(orgId);
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

  const matches = await prisma.organizationPlan.findMany({
    where: {
      organizationId: orgId,
      isActive: true,
      ...(q.planType && { planType: q.planType }),
      OR: [
        { title: { contains: q.q, mode: "insensitive" } },
        { description: { contains: q.q, mode: "insensitive" } },
      ],
    },
    orderBy: { createdAt: "desc" },
    take: q.limit,
    select: {
      id: true,
      title: true,
      description: true,
      planType: true,
      price: true,
      priceCurrency: true,
      isActive: true,
    },
  });

  return NextResponse.json({ data: matches, query: q.q });
}
