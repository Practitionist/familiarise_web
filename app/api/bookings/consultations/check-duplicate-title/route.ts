import * as Sentry from "@sentry/nextjs";
import prisma from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";
import { NO_STORE_HEADERS } from "@/lib/api/cache-headers";

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const title = searchParams.get("title");
    const consultantProfileId = searchParams.get("consultantProfileId");
    const excludeId = searchParams.get("excludeId") || "";

    if (!title || !consultantProfileId) {
      return NextResponse.json(
        { error: "Missing required parameters: title and consultantProfileId" },
        { status: 400 },
      );
    }

    const normalizedTitle = title.trim().toLowerCase();

    // Check consultation plans
    const existingConsultation = await prisma.consultationPlan.findFirst({
      where: {
        title: {
          mode: "insensitive",
          equals: normalizedTitle,
        },
        consultantProfileId: consultantProfileId,
        id: {
          not: excludeId || undefined,
        },
      },
    });

    return NextResponse.json(
      { isDuplicate: !!existingConsultation },
      {
        status: 200,
        // Owner-intent check with no auth: never shared-cache the oracle.
        headers: NO_STORE_HEADERS,
      },
    );
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "bookings" } },
    );
    console.error("Error checking duplicate consultation title:", error);
    return NextResponse.json(
      {
        error:
          "An error occurred while checking for duplicate consultation titles",
      },
      { status: 500 },
    );
  }
}
