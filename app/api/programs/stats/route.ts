import * as Sentry from "@sentry/nextjs";
import prisma from "@/lib/prisma";
import { NextResponse } from "next/server";

// Public aggregate counts (no session, no per-user data): safe for shared
// caching. Freshness TODO: plan create/publish/archive writes live outside
// this file (app/api/plans/{classes,webinars}/route.ts creates,
// app/api/plans/{classes,webinar}/[id]/route.ts archive PATCHes, plus the
// bookings crud-with-plan writers) and need revalidatePath("/api/programs/stats")
// after their commits — out of scope for this file's GET-only change.
const PUBLIC_CACHE_HEADERS = {
  "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300",
};

export async function GET() {
  try {
    const [classCount, webinarCount] = await Promise.all([
      prisma.classPlan.count(),
      prisma.webinarPlan.count(),
    ]);

    return NextResponse.json(
      {
        data: {
          classCount,
          webinarCount,
          totalPrograms: classCount + webinarCount,
        },
      },
      { headers: PUBLIC_CACHE_HEADERS },
    );
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "programs" } },
    );
    console.error("Error fetching program stats:", error);
    return NextResponse.json(
      { error: "Failed to fetch program stats" },
      { status: 500 },
    );
  }
}
