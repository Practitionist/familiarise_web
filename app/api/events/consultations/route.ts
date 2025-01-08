import prisma from "@/lib/prisma";
import { RequestStatus } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const consultantProfileId = searchParams.get("consultantProfileId");
  const consulteeProfileId = searchParams.get("consulteeProfileId");
  const status = searchParams.get("status") as RequestStatus | null;
  const page = parseInt(searchParams.get("page") || "1");
  const limit = parseInt(searchParams.get("limit") || "10");

  try {
    const whereClause: any = {};

    if (consultantProfileId) {
      whereClause.consultationPlan = {
        consultantProfile: {
          id: consultantProfileId,
        },
      };
    }

    if (consulteeProfileId) {
      whereClause.requestedById = consulteeProfileId;
    }

    if (status) {
      whereClause.requestStatus = status;
    }

    const [consultations, total] = await Promise.all([
      prisma.consultation.findMany({
        where: whereClause,
        include: {
          consultationPlan: {
            include: {
              consultantProfile: {
                include: {
                  user: true,
                },
              },
            },
          },
          requestedBy: {
            include: {
              user: true,
            },
          },
          appointment: {
            include: {
              slotsOfAppointment: {
                include: {
                  user: true,
                },
                orderBy: {
                  slotStartTimeInUTC: "asc",
                },
              },
              payment: true,
            },
          },
        },
        orderBy: {
          requestedAt: "desc",
        },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.consultation.count({ where: whereClause }),
    ]);

    return NextResponse.json({
      data: consultations,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error("Error fetching consultations:", error);
    return NextResponse.json(
      { error: "An error occurred while fetching consultations" },
      { status: 500 },
    );
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const body = await request.json();
    const { id, status } = body;

    if (!id || !status) {
      return NextResponse.json(
        { error: "ID and status are required" },
        { status: 400 },
      );
    }

    if (!Object.values(RequestStatus).includes(status as RequestStatus)) {
      return NextResponse.json({ error: "Invalid status" }, { status: 400 });
    }

    const consultation = await prisma.consultation.update({
      where: { id },
      data: { requestStatus: status },
      include: {
        consultationPlan: {
          include: {
            consultantProfile: {
              include: {
                user: true,
              },
            },
          },
        },
        requestedBy: {
          include: {
            user: true,
          },
        },
        appointment: {
          include: {
            slotsOfAppointment: {
              include: {
                user: true,
              },
            },
            payment: true,
          },
        },
      },
    });

    return NextResponse.json({ data: consultation });
  } catch (error) {
    console.error("Error updating consultation:", error);
    return NextResponse.json(
      { error: "An error occurred while updating consultation" },
      { status: 500 },
    );
  }
}
