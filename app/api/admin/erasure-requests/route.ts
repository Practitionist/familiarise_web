/**
 * GET /api/admin/erasure-requests
 *
 * Admin review queue. Surfaces PENDING + IN_PROGRESS requests first
 * (the ones that have an SLA clock), then COMPLETED / REJECTED for
 * historical context. `?open=1` narrows to the open ones — the Compliance
 * nav badge's predicate (#1527). Gated on `compliance.manage` (admin).
 */

import { NextResponse, type NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import { requireBackofficeSurface } from "@/lib/auth-helpers";
import { readPageParams } from "@/lib/backoffice/list-paging";
import { OPEN_ERASURE_WHERE } from "@/lib/backoffice/queue-predicates";

export async function GET(req: NextRequest) {
  const auth = await requireBackofficeSurface("compliance.manage");
  if (auth.error) return auth.error;

  const searchParams = new URL(req.url).searchParams;
  const open = searchParams.get("open") === "1";
  const { page, limit, skip } = readPageParams(searchParams);
  const where = open ? OPEN_ERASURE_WHERE : undefined;
  const [requests, total] = await Promise.all([
    prisma.erasureRequest.findMany({
      relationLoadStrategy: "join",
      where,
      orderBy: [{ status: "asc" }, { requestedAt: "asc" }, { id: "asc" }],
      skip,
      take: limit,
      include: {
        user: { select: { id: true, name: true, email: true, erasedAt: true } },
      },
    }),
    prisma.erasureRequest.count({ where }),
  ]);
  return NextResponse.json({ data: requests, total, page, pageSize: limit });
}
