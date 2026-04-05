import prisma from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";
import { Prisma, WebinarStatus } from "@prisma/client";
import { transformNestedPlanTopics } from "@/lib/topics";
import {
  requireApiAuth,
  isPrivileged,
  forbiddenResponse,
} from "@/lib/auth-helpers";

export async function GET(request: NextRequest) {
  // Require authentication (middleware already enforces cookie presence for /api/events/)
  const authResult = await requireApiAuth();
  if (authResult.error) return authResult.error;
  const { session } = authResult;

  try {
    const { searchParams } = new URL(request.url);
    let consulteeProfileId = searchParams.get("consulteeProfileId");
    let consultantProfileId = searchParams.get("consultantProfileId");

    // IDOR protection: non-privileged users can only request their own profile's data
    if (!isPrivileged(session.user.role)) {
      if (
        consulteeProfileId &&
        session.user.consulteeProfileId !== consulteeProfileId
      ) {
        return forbiddenResponse(
          "You can only view your own enrolled webinars",
        );
      }
      if (
        consultantProfileId &&
        session.user.consultantProfileId !== consultantProfileId
      ) {
        return forbiddenResponse("You can only view your own webinars");
      }
      // No-filter fallthrough guard: auto-fill from session so the unfiltered else
      // branch is never reached by non-privileged users with no params supplied.
      if (!consulteeProfileId && !consultantProfileId) {
        if (session.user.consulteeProfileId) {
          consulteeProfileId = session.user.consulteeProfileId;
        } else if (session.user.consultantProfileId) {
          consultantProfileId = session.user.consultantProfileId;
        } else {
          // User has no profile (e.g. incomplete onboarding) — must not reach unfiltered query
          return forbiddenResponse(
            "You are not authorized to view webinars without a profile",
          );
        }
      }
    }
    const startDateStr = searchParams.get("startDate");
    const endDateStr = searchParams.get("endDate");

    let webinars;

    const dateFilter =
      startDateStr && endDateStr
        ? {
            appointment: {
              slotsOfAppointment: {
                some: {
                  startsAt: {
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
      const whereClause: Prisma.WebinarWhereInput = {
        webinarPlan: {
          consultantProfileId,
        },
      };

      if (startDateStr && endDateStr) {
        whereClause.appointment = {
          slotsOfAppointment: {
            some: {
              startsAt: {
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

    // Transform topics from objects to strings in nested webinarPlan
    const transformedWebinars = webinars.map((w) =>
      transformNestedPlanTopics(w, "webinarPlan"),
    );

    return NextResponse.json({ data: transformedWebinars }, { status: 200 });
  } catch (error) {
    console.error("Error fetching webinars:", error);
    return NextResponse.json(
      { error: "An error occurred while fetching webinars" },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  const authResult = await requireApiAuth();
  if (authResult.error) return authResult.error;
  const { session } = authResult;

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

    // Ownership check: only the owning consultant or privileged users can schedule a webinar
    if (!isPrivileged(session.user.role)) {
      const plan = await prisma.webinarPlan.findUnique({
        where: { id: body.webinarPlanId },
        select: { consultantProfileId: true },
      });
      if (
        !plan ||
        plan.consultantProfileId !== session.user.consultantProfileId
      ) {
        return forbiddenResponse(
          "You can only create webinars for your own plans",
        );
      }
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
      { status: 500 },
    );
  }
}
