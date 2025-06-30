import prisma from "@/lib/prisma";
import { NextResponse } from "next/server";
import { WebinarStatus } from "@prisma/client";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const consulteeProfileId = searchParams.get("consulteeProfileId");
    const consultantProfileId = searchParams.get("consultantProfileId");
    const startDateStr = searchParams.get("startDate");
    const endDateStr = searchParams.get("endDate");

    let webinars;

    const dateFilter =
      startDateStr && endDateStr
        ? {
            appointment: {
              slotsOfAppointment: {
                some: {
                  slotStartTimeInUTC: {
                    gte: new Date(startDateStr),
                    lte: new Date(endDateStr),
                  },
                },
              },
            },
          }
        : {};

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
                        consulteeProfile: {
                          id: consulteeProfileId,
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
                  user: {
                    consulteeProfile: {
                      id: consulteeProfileId,
                    },
                  },
                },
              },
            },
          ],
          ...dateFilter,
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
              payment: true,
            },
          },
          // meetingRoom: true,
          waitlist: {
            where: {
              user: {
                consulteeProfile: {
                  id: consulteeProfileId,
                },
              },
            },
            include: {
              user: {
                select: {
                  id: true,
                  name: true,
                  email: true,
                  image: true,
                  consulteeProfile: true,
                },
              },
            },
          },
        },
      });
    } else if (consultantProfileId) {
      const whereClause: any = {
        webinarPlan: {
          consultantProfileId,
        },
      };

      if (startDateStr && endDateStr) {
        whereClause.appointment = {
          slotsOfAppointment: {
            some: {
              slotStartTimeInUTC: {
                gte: new Date(startDateStr),
                lte: new Date(endDateStr),
              },
            },
          },
        };
      }

      webinars = await prisma.webinar.findMany({
        where: whereClause,
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
          // meetingRoom: true,
          waitlist: true,
        },
      });
    } else {
      webinars = await prisma.webinar.findMany({
        where: { ...dateFilter },
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
          // meetingRoom: true,
          waitlist: true,
        },
      });
    }

    return NextResponse.json({ data: webinars }, { status: 200 });
  } catch (error) {
    console.error("Error fetching webinars:", error);
    return NextResponse.json(
      { error: "An error occurred while fetching webinars" },
      { status: 500 }
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
        { status: 400 }
      );
    }

    const webinar = await prisma.webinar.create({
      data: {
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
        // meetingRoom: true,
        waitlist: true,
      },
    });

    return NextResponse.json({ data: webinar }, { status: 201 });
  } catch (error) {
    console.error("Error creating webinar:", error);
    return NextResponse.json(
      { error: "An error occurred while creating the webinar" },
      { status: 500 }
    );
  }
}
