import prisma from "@/lib/prisma";
import { NextResponse } from "next/server";

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
                some: {
                  slotsOfAppointment: {
                    some: {
                      user: {
                        some: {
                          consulteeProfile: {
                            id: consulteeProfileId,
                          },
                        },
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
                  user: true, // Changed from consulteeProfile
                },
              },
            },
          },
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
                  user: true, // Changed from consulteeProfile
                },
              },
            },
          },
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

    const webinar = await prisma.webinar.create({
      data: {
        scheduledAt: new Date(body.scheduledAt),
        endAt: new Date(body.endAt),
        status: body.status,
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
                user: true, // Changed from consulteeProfile
              },
            },
          },
        },
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
