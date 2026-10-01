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
import { OPEN_ERASURE_WHERE } from "@/lib/backoffice/queue-predicates";

export async function GET(req: NextRequest) {
  const auth = await requireBackofficeSurface("compliance.manage");
  if (auth.error) return auth.error;

  const open = new URL(req.url).searchParams.get("open") === "1";
  const requests = await prisma.erasureRequest.findMany({
    where: open ? OPEN_ERASURE_WHERE : undefined,
    orderBy: [{ status: "asc" }, { requestedAt: "asc" }],
    take: 200,
    include: {
      user: { select: { id: true, name: true, email: true, erasedAt: true } },
    },
  });
  return NextResponse.json({ data: requests });
}
