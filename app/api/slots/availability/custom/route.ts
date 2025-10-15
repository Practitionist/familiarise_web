import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const consultantProfileId = searchParams.get("consultantProfileId");
    const startDate = searchParams.get("startDate");
    const endDate = searchParams.get("endDate");
    const page = parseInt(searchParams.get("page") || "1");
    const limit = parseInt(searchParams.get("limit") || "10");

    if (!consultantProfileId) {
      return NextResponse.json(
        { error: "consultantProfileId is required" },
        { status: 400 },
      );
    }

    let whereClause: any = {
      consultantProfileId: consultantProfileId,
    };

    if (startDate && endDate) {
      if (isNaN(Date.parse(startDate)) || isNaN(Date.parse(endDate))) {
        return NextResponse.json(
          { error: "Invalid date format" },
          { status: 400 },
        );
      }
      whereClause.availabilityStartsAt = {
        gte: new Date(startDate),
      };
      whereClause.availabilityEndsAt = {
        lte: new Date(endDate),
      };
    }

    const [customSlots, total] = await Promise.all([
      prisma.slotOfAvailabilityCustom.findMany({
        where: whereClause,
        orderBy: {
          availabilityStartsAt: "asc",
        },
        include: {
          consultantProfile: {
            select: {
              id: true,
              user: {
                select: {
                  name: true,
                  email: true,
                },
              },
            },
          },
        },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.slotOfAvailabilityCustom.count({ where: whereClause }),
    ]);

    return NextResponse.json(
      {
        data: customSlots,
        meta: {
          total,
          page,
          limit,
          totalPages: Math.ceil(total / limit),
        },
      },
      { status: 200 },
    );
  } catch (error) {
    console.error("Error fetching custom slots:", error);
    return NextResponse.json(
      { error: "An error occurred while fetching custom availability slots" },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { consultantProfileId, availabilityStartsAt, availabilityEndsAt } =
      body;

    if (!consultantProfileId || !availabilityStartsAt || !availabilityEndsAt) {
      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400 },
      );
    }

    if (
      isNaN(Date.parse(availabilityStartsAt)) ||
      isNaN(Date.parse(availabilityEndsAt))
    ) {
      return NextResponse.json(
        { error: "Invalid date format" },
        { status: 400 },
      );
    }

    const startTime = new Date(availabilityStartsAt);
    const endTime = new Date(availabilityEndsAt);

    if (startTime >= endTime) {
      return NextResponse.json(
        { error: "Start time must be before end time" },
        { status: 400 },
      );
    }

    // Check for overlapping slots
    const overlappingSlot = await prisma.slotOfAvailabilityCustom.findFirst({
      where: {
        consultantProfileId,
        OR: [
          {
            availabilityStartsAt: { lte: startTime },
            availabilityEndsAt: { gt: startTime },
          },
          {
            availabilityStartsAt: { lt: endTime },
            availabilityEndsAt: { gte: endTime },
          },
          {
            availabilityStartsAt: { gte: startTime },
            availabilityEndsAt: { lte: endTime },
          },
        ],
      },
    });

    if (overlappingSlot) {
      return NextResponse.json(
        { error: "This slot overlaps with an existing slot" },
        { status: 409 },
      );
    }

    const newCustomSlot = await prisma.slotOfAvailabilityCustom.create({
      data: {
        consultantProfileId,
        availabilityStartsAt: startTime,
        availabilityEndsAt: endTime,
      },
      include: {
        consultantProfile: {
          select: {
            id: true,
            user: {
              select: {
                name: true,
                email: true,
              },
            },
          },
        },
      },
    });

    return NextResponse.json({ data: newCustomSlot }, { status: 201 });
  } catch (error) {
    console.error("Error creating custom slot:", error);
    return NextResponse.json(
      {
        error: "An error occurred while creating the custom availability slot",
      },
      { status: 500 },
    );
  }
}
