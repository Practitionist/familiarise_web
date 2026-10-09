import { NextRequest, NextResponse } from "next/server";
import prisma from "lib/prisma";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { PlatformFeedbackStatusSchema } from "@/schemas/enums";

import { requirePrivilegedAuth } from "@/lib/auth-helpers";
import * as Sentry from "@sentry/nextjs";

const staffFeedbacksQuerySchema = z.object({
  status: z.union([PlatformFeedbackStatusSchema, z.literal("all")]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce
    .number()
    .int()
    .transform((n) => Math.min(100, Math.max(1, n)))
    .default(20),
});

export async function GET(req: NextRequest) {
  try {
    const auth = await requirePrivilegedAuth();
    if (auth.error) return auth.error;

    const { searchParams } = new URL(req.url);
    const parsedQuery = staffFeedbacksQuerySchema.safeParse({
      status: searchParams.get("status") ?? undefined,
      page: searchParams.get("page") ?? undefined,
      limit: searchParams.get("limit") ?? undefined,
    });
    if (!parsedQuery.success) {
      return NextResponse.json(
        {
          error: "Invalid query parameters",
          details: parsedQuery.error.issues,
        },
        { status: 400 },
      );
    }
    const { status, page, limit } = parsedQuery.data;
    const search = searchParams.get("search");

    const where: Prisma.PlatformFeedbackWhereInput = {};

    if (status && status !== "all") {
      where.status = status;
    }

    if (search) {
      where.OR = [
        { title: { contains: search, mode: "insensitive" } },
        { description: { contains: search, mode: "insensitive" } },
        { user: { name: { contains: search, mode: "insensitive" } } },
        { user: { email: { contains: search, mode: "insensitive" } } },
      ];
    }

    const [feedbacks, statusGroups] = await Promise.all([
      prisma.platformFeedback.findMany({
        where,
        include: {
          user: {
            select: {
              id: true,
              name: true,
              email: true,
              image: true,
            },
          },
        },
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.platformFeedback.groupBy({
        by: ["status"],
        ...(search ? { where: { OR: where.OR } } : {}),
        _count: { _all: true },
      }),
    ]);

    const countByStatus = new Map(
      statusGroups.map((row) => [row.status, row._count._all]),
    );
    const pending = countByStatus.get("PENDING") ?? 0;
    const acknowledged = countByStatus.get("ACKNOWLEDGED") ?? 0;
    const inProgress = countByStatus.get("IN_PROGRESS") ?? 0;
    const resolved = countByStatus.get("RESOLVED") ?? 0;
    const closed = countByStatus.get("CLOSED") ?? 0;
    const total =
      status && status !== "all"
        ? (countByStatus.get(status) ?? 0)
        : pending + acknowledged + inProgress + resolved + closed;

    return NextResponse.json({
      feedbacks,
      counts: {
        total,
        pending,
        acknowledged,
        inProgress,
        resolved,
        closed,
      },
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "staff" } },
    );
    console.error("Error fetching feedbacks:", error);
    return NextResponse.json(
      { error: "Failed to fetch feedbacks" },
      { status: 500 },
    );
  }
}
