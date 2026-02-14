import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth-server";
import { getUserReferrals } from "@/lib/referrals/service";

export async function GET() {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401 },
      );
    }

    const referrals = await getUserReferrals(session.user.id);
    return NextResponse.json({ data: referrals });
  } catch (error) {
    console.error("Error fetching referrals:", error);
    return NextResponse.json(
      { error: "Failed to fetch referrals" },
      { status: 500 },
    );
  }
}
