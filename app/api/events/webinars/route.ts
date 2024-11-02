import prisma from "@/lib/prisma";
import { NextResponse } from "next/server";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const consulteeId = searchParams.get("consulteeId");
    const consultantId = searchParams.get("consultantId");

    let webinars;

    if (consulteeId) {
      webinars = await prisma.webinar.findMany({
        where: {
          appointment: {
            some: {
              slotOfAppointment: {
                some: {
                  consulteeProfile: {
                    id: consulteeId,
                  },
                },
              },
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
              slotOfAppointment: {
                include: {
                  consulteeProfile: true,
                },
              },
            },
          },
          waitlist: true,
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
              slotOfAppointment: {
                include: {
                  consulteeProfile: true,
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
              slotOfAppointment: {
                include: {
                  consulteeProfile: true,
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
            slotOfAppointment: {
              include: {
                consulteeProfile: true,
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
