import prisma from "@/lib/prisma";
import { NextResponse } from "next/server";
import { transformNestedPlanTopics } from "@/lib/topics";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const consulteeProfileId = searchParams.get("consulteeProfileId");
    const consultantProfileId = searchParams.get("consultantProfileId");
    const startDateStr = searchParams.get("startDate");
    const endDateStr = searchParams.get("endDate");

    let classes;

    const dateFilter =
      startDateStr && endDateStr
        ? {
            // Filter classes where the class's own start date falls within the range
            schedulingPeriodStartsAt: {
              gte: new Date(startDateStr),
              lte: new Date(endDateStr),
            },
          }
        : {};

    if (consulteeProfileId) {
      classes = await prisma.class.findMany({
        where: {
          OR: [
            // Get classes where consultee is registered through appointments
            {
              appointments: {
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
            // Get classes where consultee is in waitlist
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
          classPlan: {
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
              classContents: {
                orderBy: {
                  order: "asc",
                },
              },
            },
          },
          appointments: {
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
        orderBy: [
          {
            schedulingPeriodStartsAt: "desc",
          },
          {
            status: "asc",
          },
        ],
      });
    } else if (consultantProfileId) {
      classes = await prisma.class.findMany({
        where: {
          classPlan: {
            consultantProfileId,
          },
          ...dateFilter,
        },
        include: {
          classPlan: {
            include: {
              consultantProfile: true,
              topics: true,
              classContents: {
                orderBy: {
                  order: "asc",
                },
              },
            },
          },
          appointments: true,
        },
      });
    } else {
      classes = await prisma.class.findMany({
        where: { ...dateFilter },
        include: {
          classPlan: {
            include: {
              topics: true,
            },
          },
          appointments: true,
        },
      });
    }

    // Transform topics from objects to strings in nested classPlan
    const transformedClasses = classes.map((c) =>
      transformNestedPlanTopics(c, "classPlan"),
    );

    return NextResponse.json({ data: transformedClasses }, { status: 200 });
  } catch (error) {
    console.error("Error fetching classes:", error);
    return NextResponse.json(
      { error: "An error occurred while fetching classes" },
      { status: 500 },
    );
  }
}
