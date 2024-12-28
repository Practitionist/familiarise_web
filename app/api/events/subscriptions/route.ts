import prisma from "@/lib/prisma";
import { Prisma, RequestStatus } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";

interface UpdateSubscriptionRequest {
  id: string;
  status: RequestStatus;
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const consultantProfileId = searchParams.get("consultantProfileId");
  const consulteeProfileId = searchParams.get("consulteeProfileId");
  const status = searchParams.get("status") as RequestStatus | null;
  const page = parseInt(searchParams.get("page") || "1");
  const limit = parseInt(searchParams.get("limit") || "10");

  try {
    const whereClause: Prisma.SubscriptionWhereInput = {};

    if (consultantProfileId) {
      whereClause.subscriptionPlan = {
        consultantProfileId,
      };
    }

    if (consulteeProfileId) {
      whereClause.requestedById = consulteeProfileId;
    }

    if (status) {
      whereClause.requestStatus = status;
    }

    const [subscriptions, total] = await Promise.all([
      prisma.subscription.findMany({
        where: whereClause,
        include: {
          subscriptionPlan: {
            include: {
              consultantProfile: {
                include: {
                  user: true,
                  domain: true,
                  subDomains: true,
                  tags: true,
                },
              },
            },
          },
          requestedBy: {
            include: {
              user: {
                select: {
                  id: true,
                  name: true,
                  email: true,
                  image: true,
                },
              },
            },
          },
          appointments: {
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
        orderBy: {
          requestedAt: "desc",
        },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.subscription.count({ where: whereClause }),
    ]);

    return NextResponse.json({
      data: subscriptions,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error("Error fetching subscriptions:", error);
    return NextResponse.json(
      { error: "An error occurred while fetching subscriptions" },
      { status: 500 },
    );
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const body: UpdateSubscriptionRequest = await request.json();
    const { id, status } = body;

    if (!id || !status) {
      return NextResponse.json(
        { error: "ID and status are required" },
        { status: 400 },
      );
    }

    if (!Object.values(RequestStatus).includes(status)) {
      return NextResponse.json({ error: "Invalid status" }, { status: 400 });
    }

    const subscription = await prisma.subscription.update({
      where: { id },
      data: { requestStatus: status },
      include: {
        subscriptionPlan: {
          include: {
            consultantProfile: {
              include: {
                user: {
                  select: {
                    id: true,
                    name: true,
                    email: true,
                    image: true,
                  },
                },
              },
            },
          },
        },
        requestedBy: {
          include: {
            user: {
              select: {
                id: true,
                name: true,
                email: true,
                image: true,
              },
            },
          },
        },
        appointments: {
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

    return NextResponse.json({ data: subscription });
  } catch (error) {
    console.error("Error updating subscription:", error);
    return NextResponse.json(
      { error: "An error occurred while updating subscription" },
      { status: 500 },
    );
  }
}
