import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";

export async function GET(
    req: NextRequest,
    res: NextResponse,
) {
    try {
        const { searchParams } = new URL(req.url);
        const consultantId = searchParams.get('consultantId');
        const startDate = searchParams.get('startDate');
        const endDate = searchParams.get('endDate');

        let whereClause: any = {};

        if (consultantId) {
            whereClause.consultantId = consultantId;
        }

        if (startDate && endDate) {
            whereClause.date = {
                gte: new Date(startDate),
                lte: new Date(endDate),
            };
        }

        const customSlots = await prisma.slotOfAvailabiltyCustom.findMany({
            where: whereClause,
        });

        return NextResponse.json(customSlots, { status: 200 });
    } catch (error) {
        console.error("Error fetching slot:", error);
        return NextResponse.json(
            { error: "Something went wrong" },
            { status: 500 }
        );
    }
}