import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth-server";
import { calculateRevenueSplit } from "@/lib/collaborators/service";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;
    const amount = Number(req.nextUrl.searchParams.get("amount") || "10000");

    const splits = await calculateRevenueSplit("webinar", id, amount);
    return NextResponse.json({ data: splits });
  } catch (error) {
    console.error("Error calculating revenue split:", error);
    return NextResponse.json(
      { error: "Failed to calculate revenue split" },
      { status: 500 },
    );
  }
}
