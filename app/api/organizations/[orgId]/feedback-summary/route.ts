/**
 * GET /api/organizations/[orgId]/feedback-summary
 *
 * #support-hub — ORG QUALITY SIGNAL over members' private per-appointment
 * CSAT (AppointmentFeedback). Gated on `operations.read`.
 *
 * AGGREGATES ONLY, by design (ADR 20): the rating and the comment are session
 * content — the schema comment "feeds the org-level quality signal" means this
 * endpoint's shape, not a per-member table. No rows leave this endpoint; there
 * is deliberately no drill-down.
 */

import { NextResponse } from "next/server";
import { requireOrgAccess } from "@/lib/auth-helpers";
import prisma from "@/lib/prisma";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  const access = await requireOrgAccess(orgId, { permission: "operations.read" });
  if (access.error) return access.error;

  const since30d = new Date(Date.now() - 30 * 24 * 3_600_000);

  const [overall, last30] = await Promise.all([
    prisma.appointmentFeedback.aggregate({
      where: { organizationId: orgId },
      _avg: { rating: true },
      _count: { _all: true },
    }),
    prisma.appointmentFeedback.aggregate({
      where: { organizationId: orgId, createdAt: { gte: since30d } },
      _avg: { rating: true },
      _count: { _all: true },
    }),
  ]);

  // Round to one decimal — an average of 4.333333 renders worse than it reads.
  const round1 = (n: number | null) => (n === null ? null : Math.round(n * 10) / 10);

  // Minimum cohort size: below this, the "average" is (part of) one member's
  // exact private rating and the count makes the disclosure trivial — which
  // ADR 20 forbids. Suppress until the aggregate is actually anonymous.
  const MIN_COHORT = 3;

  return NextResponse.json({
    data: {
      averageRating:
        overall._count._all >= MIN_COHORT ? round1(overall._avg.rating) : null,
      totalResponses: overall._count._all,
      averageRating30d:
        last30._count._all >= MIN_COHORT ? round1(last30._avg.rating) : null,
      responses30d: last30._count._all,
    },
  });
}
