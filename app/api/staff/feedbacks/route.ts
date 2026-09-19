import { NextRequest, NextResponse } from "next/server";
import prisma from "lib/prisma";
import { PlatformFeedbackStatus, Prisma } from "@prisma/client";

import { requirePrivilegedAuth } from "@/lib/auth-helpers";
import * as Sentry from "@sentry/nextjs";
export async function GET(req: NextRequest) {
  try {
    const auth = await requirePrivilegedAuth();
    if (auth.error) return auth.error;

    const { searchParams } = new URL(req.url);
    const status = searchParams.get("status");
    const search = searchParams.get("search");
    const page = parseInt(searchParams.get("page") || "1");
    const limit = parseInt(searchParams.get("limit") || "20");

    // Build where clause
    const where: Prisma.PlatformFeedbackWhereInput = {};

    if (status && status !== "all") {
      where.status = status as PlatformFeedbackStatus;
    }

    if (search) {
      where.OR = [
        { title: { contains: search, mode: "insensitive" } },
        { description: { contains: search, mode: "insensitive" } },
        { user: { name: { contains: search, mode: "insensitive" } } },
        { user: { email: { contains: search, mode: "insensitive" } } },
      ];
    }

    // Get feedbacks with pagination
    const [feedbacks, total] = await Promise.all([
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
      prisma.platformFeedback.count({ where }),
    ]);

    // Get status counts
    const [pending, acknowledged, inProgress, resolved, closed] =
      await Promise.all([
        prisma.platformFeedback.count({ where: { status: "PENDING" } }),
        prisma.platformFeedback.count({ where: { status: "ACKNOWLEDGED" } }),
        prisma.platformFeedback.count({ where: { status: "IN_PROGRESS" } }),
        prisma.platformFeedback.count({ where: { status: "RESOLVED" } }),
        prisma.platformFeedback.count({ where: { status: "CLOSED" } }),
      ]);

    return NextResponse.json(
      {
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
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "staff" } },
    );
    console.error("Error fetching feedbacks:", error);
    return NextResponse.json(
      { error: "Failed to fetch feedbacks" },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
