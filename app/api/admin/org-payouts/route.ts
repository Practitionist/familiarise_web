/**
 * GET /api/admin/org-payouts — organisation payouts for the money console,
 * newest first, filtered by status and org; staff read it too (`payouts.read`).
 * Who created and approved each row is one batched user read per page.
 */

import { NextRequest, NextResponse } from "next/server";

import prisma from "@/lib/prisma";
import { requireBackofficeSurface } from "@/lib/auth-helpers";
import { parseRequestBody } from "@/lib/api/parse";
import { reportSentryError } from "@/lib/observability/report";
import { adminOrgPayoutsQuerySchema } from "@/schemas/payouts";

export async function GET(req: NextRequest) {
  try {
    const auth = await requireBackofficeSurface("payouts.read");
    if (auth.error) return auth.error;

    const { searchParams } = new URL(req.url);
    const { data: query, error } = parseRequestBody(
      adminOrgPayoutsQuerySchema,
      {
        status: searchParams.get("status"),
        orgId: searchParams.get("orgId"),
        limit: searchParams.get("limit") ?? undefined,
        offset: searchParams.get("offset") ?? undefined,
      },
      "Invalid query parameters",
    );
    if (error) return error;

    const where = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.orgId ? { organizationId: query.orgId } : {}),
    };
    const [rows, total] = await Promise.all([
      prisma.organizationPayout.findMany({
        relationLoadStrategy: "join",
        where,
        select: {
          id: true,
          organizationId: true,
          organization: { select: { name: true, slug: true } },
          amountPaise: true,
          netPayoutPaise: true,
          tdsAmountPaise: true,
          currency: true,
          status: true,
          periodStart: true,
          periodEnd: true,
          createdAt: true,
          createdBy: true,
          orgApprovedBy: true,
          approvedBy: true,
          approvedAt: true,
          platformApprovalRequiredAt: true,
          platformHeldAt: true,
          failureReason: true,
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: query.limit,
        skip: query.offset,
      }),
      prisma.organizationPayout.count({ where }),
    ]);
    const userIds = [
      ...new Set(
        rows.flatMap((r) => [r.createdBy, r.orgApprovedBy, r.approvedBy]),
      ),
    ].filter((id): id is string => Boolean(id));
    const users = userIds.length
      ? await prisma.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, name: true, email: true },
        })
      : [];
    const byId = new Map(users.map((u) => [u.id, u]));
    // A removed user keeps their id, so the row still says who it was.
    const person = (id: string | null) =>
      id ? (byId.get(id) ?? { id, name: null, email: null }) : null;
    const payouts = rows.map((r) => ({
      ...r,
      createdByUser: person(r.createdBy),
      orgApprovedByUser: person(r.orgApprovedBy),
      approvedByUser: person(r.approvedBy),
    }));

    return NextResponse.json(
      {
        payouts,
        pagination: {
          total,
          limit: query.limit,
          offset: query.offset,
          hasMore: query.offset + query.limit < total,
        },
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    reportSentryError(err, { subsystem: "admin", op: "org-payouts.list" });
    return NextResponse.json(
      { error: "Failed to fetch organisation payouts" },
      { status: 500 },
    );
  }
}
