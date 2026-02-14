import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth-server";
import { getCreditHistory, getUserCredits } from "@/lib/referrals/service";

export async function GET() {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401 },
      );
    }

    const [{ totalAvailable }, history] = await Promise.all([
      getUserCredits(session.user.id),
      getCreditHistory(session.user.id),
    ]);

    return NextResponse.json({
      data: {
        totalAvailable,
        history,
      },
    });
  } catch (error) {
    console.error("Error fetching credits:", error);
    return NextResponse.json(
      { error: "Failed to fetch credits" },
      { status: 500 },
    );
  }
}
