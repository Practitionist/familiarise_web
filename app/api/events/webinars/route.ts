import prisma from "@/lib/prisma";
import { NextResponse } from "next/server";
import { WebinarStatus } from "@prisma/client";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const consulteeProfileId = searchParams.get("consulteeProfileId");
    const consultantId = searchParams.get("consultantId");

    let webinars;

    if (consulteeProfileId) {
      webinars = await prisma.webinar.findMany({
        where: {
          OR: [
            // Get webinars where consultee is registered through appointments
            {
              appointment: {
                slotsOfAppointment: {
                  some: {
                    user: {
                      some: {
                        consulteeProfileId: consulteeProfileId,
                      },
                    },
                  },
                },
              },
            },
            // Get webinars where consultee is in waitlist
            {
              waitlist: {
                some: {
                  userId: consulteeProfileId,
                },
              },
            },
          ],
        },
        include: {
          webinarPlan: {
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
              topics: true,
            },
          },
          appointment: {
            include: {
              slotsOfAppointment: {
                include: {
                  user: {
                    select: {
                      id: true,
                      name: true,
                      email: true,
                      image: true,
                      consulteeProfileId: true,
                    },
                  },
                },
              },
              payment: {
                select: {
                  paymentStatus: true,
                },
              },
            },
          },
          meetingRoom: true,
          waitlist: {
            where: {
              userId: consulteeProfileId,
            },
            select: {
              userId: true,
              joinedAt: true,
            },
          },
        },
        orderBy: {
          scheduledAt: "desc",
        },
      });
    } else if (consultantId) {
      webinars = await prisma.webinar.findMany({
        where: {
          webinarPlan: {
            consultantProfile: {
              id: consultantId,
            },
          },
        },
        include: {
          webinarPlan: {
            include: {
              consultantProfile: true,
              topics: true,
            },
          },
          appointment: {
            include: {
              slotsOfAppointment: {
                include: {
                  user: true,
                },
              },
            },
          },
          meetingRoom: true,
          waitlist: true,
        },
      });
    } else {
      webinars = await prisma.webinar.findMany({
        include: {
          webinarPlan: {
            include: {
              consultantProfile: true,
              topics: true,
            },
          },
          appointment: {
            include: {
              slotsOfAppointment: {
                include: {
                  user: true,
                },
              },
            },
          },
          meetingRoom: true,
          waitlist: true,
        },
      });
    }

    return NextResponse.json({ data: webinars }, { status: 200 });
  } catch (error) {
    console.error("Error fetching webinars:", error);
    return NextResponse.json(
      { error: "An error occurred while fetching webinars" },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();

    // Validate required fields
    if (!body.scheduledAt || !body.endAt || !body.webinarPlanId) {
      return NextResponse.json(
        {
          error:
            "Missing required fields: scheduledAt, endAt, and webinarPlanId are required",
        },
        { status: 400 },
      );
    }

    const webinar = await prisma.webinar.create({
      data: {
        scheduledAt: new Date(body.scheduledAt),
        endAt: new Date(body.endAt),
        status: body.status || WebinarStatus.SCHEDULED,
        webinarPlan: {
          connect: { id: body.webinarPlanId },
        },
      },
      include: {
        webinarPlan: {
          include: {
            consultantProfile: true,
            topics: true,
          },
        },
        appointment: {
          include: {
            slotsOfAppointment: {
              include: {
                user: true,
              },
            },
          },
        },
        meetingRoom: true,
        waitlist: true,
      },
    });

    return NextResponse.json({ data: webinar }, { status: 201 });
  } catch (error) {
    console.error("Error creating webinar:", error);
    return NextResponse.json(
      { error: "An error occurred while creating the webinar" },
      { status: 500 },
    );
  }
}
