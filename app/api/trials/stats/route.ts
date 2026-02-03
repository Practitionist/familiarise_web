import prisma from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";

/**
 * GET /api/trials/stats
 * Returns summary counts of trial sessions grouped by status
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const consultantProfileId = searchParams.get("consultantProfileId");

  if (!consultantProfileId) {
    return NextResponse.json(
      { error: "consultantProfileId is required" },
      { status: 400 },
    );
  }

  try {
    const counts = await prisma.trialSession.groupBy({
      by: ["status"],
      where: { consultantProfileId },
      _count: { status: true },
    });

    const data = Object.fromEntries(
      counts.map((c) => [c.status, c._count.status]),
    );

    return NextResponse.json({ data });
  } catch (error) {
    console.error("Error fetching trial stats:", error);
    return NextResponse.json(
      { error: "An error occurred while fetching trial stats" },
      { status: 500 },
    );
  }
}
