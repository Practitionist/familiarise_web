import * as Sentry from "@sentry/nextjs";
import { NextResponse, type NextRequest } from "next/server";
import prisma from "@/lib/prisma";
import {
  isPrivileged,
  forbiddenResponse,
  requireApiAuth,
} from "@/lib/auth-helpers";

// GET /api/user/staff - Get all staff members (ADMIN/STAFF only)
export async function GET(_request: NextRequest) {
  try {
    // Require authentication
    const authResult = await requireApiAuth();
    if (authResult.error) return authResult.error;
    const { session } = authResult;

    // Only ADMIN/STAFF can list staff members
    if (!isPrivileged(session.user.role)) {
      return forbiddenResponse(
        "Only administrators and staff can view staff members",
      );
    }

    const staffUsers = await prisma.user.findMany({
      where: {
        role: "STAFF",
      },
      include: {
        staffProfile: true, // Include related staff profile data
      },
    });

    return NextResponse.json(staffUsers);
  } catch (error) {
    console.error("Failed to fetch staff users:", error);
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "staff" } },
    );
    return NextResponse.json(
      { message: "Internal Server Error fetching staff" },
      { status: 500 },
    );
  }
}
