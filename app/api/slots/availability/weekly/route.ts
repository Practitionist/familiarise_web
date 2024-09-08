import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";

export async function GET(
    req: NextRequest,
    res: NextResponse,
) {
    try {
        const consultantId = req.nextUrl.searchParams.get('consultantId');
        const startDate = req.nextUrl.searchParams.get('startDate');
        const endDate = req.nextUrl.searchParams.get('endDate');

        let whereClause: any = {};

        if (consultantId) {
            whereClause.consultantProfileId = consultantId;
        }

        if (startDate && endDate) {
            whereClause.slotStartTimeInUTC = {
                gte: new Date(startDate),
                lte: new Date(endDate)
            };
        }

        const weeklySlots = await prisma.slotOfAvailabiltyWeekly.findMany({
            where: whereClause
        });

        return NextResponse.json(weeklySlots, { status: 200 });
    } catch (error) {
        console.error("Error fetching slot:", error);
        return NextResponse.json(
            { error: "Something went wrong" },
            { status: 500 }
        );
    }
}