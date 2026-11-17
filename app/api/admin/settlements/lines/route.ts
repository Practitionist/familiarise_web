import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { GatewaySettlementLineStatus } from "@prisma/client";
import prisma from "@/lib/prisma";
import { requireBackofficeSurface } from "@/lib/auth-helpers";
import { reportSentryError } from "@/lib/observability/report";

const querySchema = z.object({
  status: z.nativeEnum(GatewaySettlementLineStatus).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

/** Settlement recon lines for ops, newest first; `?status=` narrows to one outcome. */
export async function GET(req: NextRequest) {
  const auth = await requireBackofficeSurface("payouts.read");
  if (auth.error) return auth.error;

  const params = req.nextUrl.searchParams;
  const parsed = querySchema.safeParse({
    status: params.get("status") ?? undefined,
    page: params.get("page") ?? undefined,
    limit: params.get("limit") ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid query parameters", details: parsed.error.issues },
      { status: 400 },
    );
  }
  const { status, page, limit } = parsed.data;
  const where = status ? { status } : {};

  try {
    const [total, lines] = await Promise.all([
      prisma.gatewaySettlementLine.count({ where }),
      prisma.gatewaySettlementLine.findMany({
        where,
        orderBy: [{ fetchedAt: "desc" }, { id: "asc" }],
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);
    return NextResponse.json({ lines, total, page, limit });
  } catch (error) {
    reportSentryError(error, { subsystem: "payments", op: "settlement-lines" });
    return NextResponse.json(
      { error: "Failed to load settlement lines" },
      { status: 500 },
    );
  }
}
