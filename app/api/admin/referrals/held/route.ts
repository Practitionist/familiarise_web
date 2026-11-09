/**
 * GET /api/admin/referrals/held — ADMIN's queue of referrals the vest sweep held for review.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import prisma from "@/lib/prisma";
import { requireBackofficeSurface } from "@/lib/auth-helpers";

const QuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

const party = { select: { id: true, name: true, email: true } } as const;

export async function GET(req: NextRequest) {
  const auth = await requireBackofficeSurface("referrals.manage");
  if (auth.error) return auth.error;

  const sp = new URL(req.url).searchParams;
  const parsed = QuerySchema.safeParse({
    page: sp.get("page") ?? undefined,
    limit: sp.get("limit") ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: parsed.error.issues[0]?.message ?? "Invalid query parameters",
        code: "INVALID_QUERY",
      },
      { status: 400 },
    );
  }
  const { page, limit } = parsed.data;
  const where = { status: "HELD" as const };
  const [rows, total] = await Promise.all([
    prisma.referral.findMany({
      where,
      select: {
        id: true,
        heldAt: true,
        heldReason: true,
        signedUpAt: true,
        qualifiedAt: true,
        referredUser: party,
        referralCode: { select: { code: true, user: party } },
        qualifyingPayment: {
          select: { id: true, amount: true, capturedAt: true },
        },
      },
      orderBy: { heldAt: "asc" },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.referral.count({ where }),
  ]);

  return NextResponse.json({
    data: rows,
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
  });
}
