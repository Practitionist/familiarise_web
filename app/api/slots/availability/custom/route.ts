import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";

export async function GET(
    req: NextRequest,
    res: NextResponse,
) {
    try {
        const customSlots = await prisma.slotOfAvailabiltyCustom.findMany({});
        return NextResponse.json(customSlots, { status: 200 });
    } catch (error) {
        console.error("Error fetching slot:", error);
        return NextResponse.json(
            { error: "Something went wrong" },
            { status: 500 }
        );
    }
}