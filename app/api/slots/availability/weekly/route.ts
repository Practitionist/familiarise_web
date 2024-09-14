import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { DayOfWeek } from "@prisma/client";

export async function GET(req: NextRequest) {
    try {
        const { searchParams } = new URL(req.url);
        const consultantProfileId = searchParams.get('consultantProfileId');

        if (!consultantProfileId) {
            return NextResponse.json({ error: "consultantProfileId is required" }, { status: 400 });
        }

        const weeklySlots = await prisma.slotOfAvailabilityWeekly.findMany({
            where: {
                consultantProfileId: consultantProfileId
            },
            orderBy: [
                { dayOfWeekforStartTimeInUTC: 'asc' },
                { slotStartTimeInUTC: 'asc' }
            ],
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

        return NextResponse.json(weeklySlots, { status: 200 });
    } catch (error) {
        console.error("Error fetching weekly slots:", error);
        return NextResponse.json(
            { error: "An error occurred while fetching weekly availability slots" },
            { status: 500 }
        );
    }
}

export async function POST(req: NextRequest) {
    try {
        const body = await req.json();
        const { consultantProfileId, dayOfWeekforStartTimeInUTC, dayOfWeekforEndTimeInUTC, slotStartTimeInUTC, slotEndTimeInUTC } = body;

        if (!consultantProfileId || !dayOfWeekforStartTimeInUTC || !dayOfWeekforEndTimeInUTC || !slotStartTimeInUTC || !slotEndTimeInUTC) {
            return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
        }

        if (!Object.values(DayOfWeek).includes(dayOfWeekforStartTimeInUTC) || !Object.values(DayOfWeek).includes(dayOfWeekforEndTimeInUTC)) {
            return NextResponse.json({ error: "Invalid day of week" }, { status: 400 });
        }

        if (isNaN(Date.parse(slotStartTimeInUTC)) || isNaN(Date.parse(slotEndTimeInUTC))) {
            return NextResponse.json({ error: "Invalid time format" }, { status: 400 });
        }

        const startTime = new Date(slotStartTimeInUTC);
        const endTime = new Date(slotEndTimeInUTC);

        if (startTime >= endTime) {
            return NextResponse.json({ error: "Start time must be before end time" }, { status: 400 });
        }

        const newWeeklySlot = await prisma.slotOfAvailabilityWeekly.create({
            data: {
                consultantProfileId,
                dayOfWeekforStartTimeInUTC,
                dayOfWeekforEndTimeInUTC,
                slotStartTimeInUTC: startTime,
                slotEndTimeInUTC: endTime
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

        return NextResponse.json(newWeeklySlot, { status: 201 });
    } catch (error) {
        console.error("Error creating weekly slot:", error);
        return NextResponse.json(
            { error: "An error occurred while creating the weekly availability slot" },
            { status: 500 }
        );
    }
}