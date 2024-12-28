import prisma from "@/lib/prisma";
import { NextResponse } from "next/server";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const consulteeProfileId = searchParams.get("consulteeProfileId");
    const consultantId = searchParams.get("consultantId");

    let classes;

    if (consulteeProfileId) {
      classes = await prisma.class.findMany({
        where: {
          OR: [
            // Get classes where consultee is registered through appointments
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
            // Get classes where consultee is in waitlist
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
            startDate: "desc",
          },
          {
            status: "asc",
          },
        ],
      });
    } else if (consultantId) {
      classes = await prisma.class.findMany({
        where: {
          classPlan: {
            consultantProfile: {
              id: consultantId,
            },
          },
        },
        include: {
          classPlan: {
            include: {
              consultantProfile: true,
            },
          },
          appointment: true,
        },
      });
      console.log("classes", classes);
    } else {
      classes = await prisma.class.findMany({
        include: {
          classPlan: true,
          appointment: true,
        },
      });
    }

    return NextResponse.json({ data: classes }, { status: 200 });
  } catch (error) {
    console.error("Error fetching classes:", error);
    return NextResponse.json(
      { error: "An error occurred while fetching classes" },
      { status: 500 },
    );
  }
}
