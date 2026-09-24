import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import prisma from "@/lib/prisma";
import { getSession } from "@/lib/auth-server";
import { userIdQuerySchema } from "@/schemas/user";

/**
 * GET /api/profiles/consultee
 * Get consultee profile by user ID. Self-or-privileged: both callers look
 * up their own profile, and the payload carries PII (email), so unlike the
 * public consultant endpoint this is not an anonymous oracle.
 * Query params:
 * - userId: The user ID to get the consultee profile for
 */
export async function GET(request: NextRequest) {
  try {
    const session = await getSession(true);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const searchParams = request.nextUrl.searchParams;
    const userId = searchParams.get("userId");

    const parsedUserId = userIdQuerySchema.safeParse({ userId });
    if (!parsedUserId.success) {
      return NextResponse.json({ error: "Invalid userId" }, { status: 400 });
    }

    const isPrivileged =
      session.user.role === "ADMIN" || session.user.role === "STAFF";
    if (parsedUserId.data.userId !== session.user.id && !isPrivileged) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const consulteeProfile = await prisma.consulteeProfile.findUnique({
      where: { userId: parsedUserId.data.userId },
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
    });

    if (!consulteeProfile) {
      return NextResponse.json(
        { error: "Consultee profile not found" },
        { status: 404 },
      );
    }

    return NextResponse.json({
      success: true,
      data: consulteeProfile,
    });
  } catch (error) {
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "auth" } });
    console.error("Error fetching consultee profile:", error);
    return NextResponse.json(
      {
        success: false,
        error: "Failed to fetch consultee profile",
        message: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
