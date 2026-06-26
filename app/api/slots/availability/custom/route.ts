import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import prisma from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { getSession } from "@/lib/auth-server";

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

    const whereClause: Prisma.SlotOfAvailabilityCustomWhereInput = {
      consultantProfileId: consultantProfileId,
    };

    if (startDate && endDate) {
      if (isNaN(Date.parse(startDate)) || isNaN(Date.parse(endDate))) {
        return NextResponse.json(
          { error: "Invalid date format" },
          { status: 400 },
        );
      }
      whereClause.startsAt = {
        gte: new Date(startDate),
      };
      whereClause.endsAt = {
        lte: new Date(endDate),
      };
    }

    const [customSlots, total] = await Promise.all([
      prisma.slotOfAvailabilityCustom.findMany({
        where: whereClause,
        orderBy: {
          startsAt: "asc",
        },
        include: {
          consultantProfile: {
            select: {
              id: true,
              user: {
                select: {
                  name: true,
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
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "scheduling" } });
    console.error("Error fetching custom slots:", error);
    return NextResponse.json(
      { error: "An error occurred while fetching custom availability slots" },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    // Auth check
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json(
        { error: "Authentication required" },
        { status: 401 },
      );
    }

    const body = await req.json();
    const { consultantProfileId, startsAt, endsAt } = body;

    if (!consultantProfileId || !startsAt || !endsAt) {
      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400 },
      );
    }

    // Ownership check
    const consultantProfile = await prisma.consultantProfile.findUnique({
      where: { id: consultantProfileId },
      select: { userId: true },
    });
    if (!consultantProfile || consultantProfile.userId !== session.user.id) {
      return NextResponse.json(
        { error: "Forbidden: you do not own this consultant profile" },
        { status: 403 },
      );
    }

    if (isNaN(Date.parse(startsAt)) || isNaN(Date.parse(endsAt))) {
      return NextResponse.json(
        { error: "Invalid date format" },
        { status: 400 },
      );
    }

    const startTime = new Date(startsAt);
    const endTime = new Date(endsAt);

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
            startsAt: { lte: startTime },
            endsAt: { gt: startTime },
          },
          {
            startsAt: { lt: endTime },
            endsAt: { gte: endTime },
          },
          {
            startsAt: { gte: startTime },
            endsAt: { lte: endTime },
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
        startsAt: startTime,
        endsAt: endTime,
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
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "scheduling" } });
    console.error("Error creating custom slot:", error);
    return NextResponse.json(
      {
        error: "An error occurred while creating the custom availability slot",
      },
      { status: 500 },
    );
  }
}
