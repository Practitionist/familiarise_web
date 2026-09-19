import * as Sentry from "@sentry/nextjs";
import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth-server";
import { getUserCredits } from "@/lib/referrals/service";

export async function GET() {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401, headers: { "Cache-Control": "no-store" } },
      );
    }

    const { totalAvailable } = await getUserCredits(session.user.id);

    return NextResponse.json(
      {
        data: { totalAvailable, currency: "INR" },
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "referrals" } },
    );
    console.error("Error fetching available credits:", error);
    return NextResponse.json(
      { error: "Failed to fetch available credits" },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
