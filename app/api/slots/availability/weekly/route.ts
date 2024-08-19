import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";

export async function GET(
    req: NextRequest,
    res: NextResponse,
) {
    try {
        const weeklySlots = await prisma.slotOfAvailabiltyWeekly.findMany({});
        return NextResponse.json(weeklySlots, { status: 200 });
    } catch (error) {
        console.error("Error fetching slot:", error);
        return NextResponse.json(
            { error: "Something went wrong" },
            { status: 500 }
        );
    }
}