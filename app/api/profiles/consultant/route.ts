import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";

/**
 * GET /api/profiles/consultant
 * Get consultant profile by user ID
 * Query params:
 * - userId: The user ID to get the consultant profile for
 */
export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const userId = searchParams.get("userId");

    if (!userId) {
      return NextResponse.json(
        { error: "userId is required" },
        { status: 400 },
      );
    }

    const consultantProfile = await prisma.consultantProfile.findUnique({
      where: { userId },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            image: true,
          },
        },
        domain: true,
        subDomains: true,
        tags: true,
      },
    });

    if (!consultantProfile) {
      return NextResponse.json(
        { error: "Consultant profile not found" },
        { status: 404 },
      );
    }

    return NextResponse.json({
      success: true,
      data: consultantProfile,
    });
  } catch (error) {
    console.error("Error fetching consultant profile:", error);
    return NextResponse.json(
      {
        success: false,
        error: "Failed to fetch consultant profile",
        message: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
