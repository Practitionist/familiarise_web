import * as Sentry from "@sentry/nextjs";
import prisma from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";
import { UserRole } from "@prisma/client";

import { getSession } from "@/lib/auth-server";
export async function GET(req: NextRequest) {
  try {
    const session = await getSession(true);
    if (!session || session.user.role !== "ADMIN") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(req.url);
    const page = parseInt(searchParams.get("page") || "1");
    const limit = parseInt(searchParams.get("limit") || "10");
    const role = searchParams.get("role") as UserRole | null;

    const skip = (page - 1) * limit;

    const whereClause = role ? { role } : {};

    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where: whereClause,
        skip,
        take: limit,
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          onboardingCompleted: true,
        },
      }),
      prisma.user.count({ where: whereClause }),
    ]);

    return NextResponse.json(
      {
        data: users,
        meta: {
          total,
          page,
          limit,
          totalPages: Math.ceil(total / limit),
        },
      },
      { status: 200 },
    );
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "auth" } },
    );
    console.error("Error getting users:", error);
    return NextResponse.json(
      { error: "An error occurred while fetching users" },
      { status: 500 },
    );
  }
}
