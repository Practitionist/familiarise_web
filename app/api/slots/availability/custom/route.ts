import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";

export async function GET(req: NextRequest) {
    try {
        const { searchParams } = new URL(req.url);
        const consultantProfileId = searchParams.get('consultantProfileId');
        const startDate = searchParams.get('startDate');
        const endDate = searchParams.get('endDate');

        if (!consultantProfileId) {
            return NextResponse.json({ error: "consultantProfileId is required" }, { status: 400 });
        }

        let whereClause: any = {
            consultantProfileId: consultantProfileId
        };

        if (startDate && endDate) {
            if (isNaN(Date.parse(startDate)) || isNaN(Date.parse(endDate))) {
                return NextResponse.json({ error: "Invalid date format" }, { status: 400 });
            }
            whereClause.slotStartTimeInUTC = {
                gte: new Date(startDate),
            };
            whereClause.slotEndTimeInUTC = {
                lte: new Date(endDate),
            };
        }

        const customSlots = await prisma.slotOfAvailabilityCustom.findMany({
            where: whereClause,
            orderBy: {
                slotStartTimeInUTC: 'asc'
            },
            include: {
                consultantProfile: {
                    select: {
                        id: true,
                        user: {
                            select: {
                                name: true,
                                email: true
                            }
                        }
                    }
                }
            }
        });

        return NextResponse.json(customSlots, { status: 200 });
    } catch (error) {
        console.error("Error fetching custom slots:", error);
        return NextResponse.json(
            { error: "An error occurred while fetching custom availability slots" },
            { status: 500 }
        );
    }
}

export async function POST(req: NextRequest) {
    try {
        const body = await req.json();
        const { consultantProfileId, slotStartTimeInUTC, slotEndTimeInUTC } = body;

        if (!consultantProfileId || !slotStartTimeInUTC || !slotEndTimeInUTC) {
            return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
        }

        if (isNaN(Date.parse(slotStartTimeInUTC)) || isNaN(Date.parse(slotEndTimeInUTC))) {
            return NextResponse.json({ error: "Invalid date format" }, { status: 400 });
        }

        if (new Date(slotStartTimeInUTC) >= new Date(slotEndTimeInUTC)) {
            return NextResponse.json({ error: "Start time must be before end time" }, { status: 400 });
        }

        const newCustomSlot = await prisma.slotOfAvailabilityCustom.create({
            data: {
                consultantProfileId,
                slotStartTimeInUTC: new Date(slotStartTimeInUTC),
                slotEndTimeInUTC: new Date(slotEndTimeInUTC)
            },
            include: {
                consultantProfile: {
                    select: {
                        id: true,
                        user: {
                            select: {
                                name: true,
                                email: true
                            }
                        }
                    }
                }
            }
        });

        return NextResponse.json(newCustomSlot, { status: 201 });
    } catch (error) {
        console.error("Error creating custom slot:", error);
        return NextResponse.json(
            { error: "An error occurred while creating the custom availability slot" },
            { status: 500 }
        );
    }
}