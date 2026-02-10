import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth-server";
import { calculateRevenueSplit } from "@/lib/collaborators/service";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ planId: string }> },
) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { planId } = await params;
    const amount = Number(req.nextUrl.searchParams.get("amount") || "10000");

    const splits = await calculateRevenueSplit("class", planId, amount);
    return NextResponse.json({ data: splits });
  } catch (error) {
    console.error("Error calculating revenue split:", error);
    return NextResponse.json(
      { error: "Failed to calculate revenue split" },
      { status: 500 },
    );
  }
}
