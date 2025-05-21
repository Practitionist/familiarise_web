import * as Sentry from "@sentry/nextjs";
import prisma from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const page = parseInt(searchParams.get("page") || "1");
    const limit = parseInt(searchParams.get("limit") || "10");
    // Calculate offset
    const skip = (page - 1) * limit;

    const consultees = await prisma.consulteeProfile.findMany({
      include: {
        consultantReviews: true,
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            image: true,
          },
        },
      },
      skip,
      take: limit,
    });

    return NextResponse.json(consultees, { status: 200 });
  } catch (error) {
    Sentry.captureException(error);
    console.error("Error getting consultees:", error);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 },
    );
  }
}
