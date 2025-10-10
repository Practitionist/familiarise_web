import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ consultantId: string }> },
) {
  try {
    const { consultantId } = await params;

    if (!consultantId) {
      return NextResponse.json(
        { error: "Consultant ID is required" },
        { status: 400 },
      );
    }

    // Fetch webinars and classes in parallel using direct Prisma queries
    const [webinars, classes] = await Promise.all([
      // Webinars with participant counts
      prisma.webinar.findMany({
        where: {
          webinarPlan: {
            consultantProfileId: consultantId,
          },
        },
        select: {
          id: true,
          status: true,
          feedbackSummary: true,
          createdAt: true,
          webinarPlan: {
            select: {
              id: true,
              title: true,
              description: true,
              price: true,
              durationInHours: true,
              maxParticipants: true,
              language: true,
              level: true,
              consultantProfile: {
                select: {
                  id: true,
                  user: {
                    select: {
                      id: true,
                      name: true,
                      image: true,
                    },
                  },
                },
              },
              topics: {
                select: {
                  id: true,
                  name: true,
                },
              },
            },
          },
          appointment: {
            select: {
              id: true,
              slotsOfAppointment: {
                select: {
                  id: true,
                  slotStartTimeInUTC: true,
                  slotEndTimeInUTC: true,
                  isTentative: true,
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
          waitlist: {
            select: {
              id: true,
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
        orderBy: {
          createdAt: "desc",
        },
      }),

      // Classes with participant counts
      prisma.class.findMany({
        where: {
          classPlan: {
            consultantProfileId: consultantId,
          },
        },
        select: {
          id: true,
          status: true,
          startDate: true,
          endDate: true,
          feedbackSummary: true,
          recordingUrls: true,
          createdAt: true,
          classPlan: {
            select: {
              id: true,
              title: true,
              description: true,
              price: true,
              durationInMonths: true,
              callsPerWeek: true,
              sessionDurationInHours: true,
              maxParticipants: true,
              language: true,
              level: true,
              consultantProfile: {
                select: {
                  id: true,
                  user: {
                    select: {
                      id: true,
                      name: true,
                      image: true,
                    },
                  },
                },
              },
              topics: {
                select: {
                  id: true,
                  name: true,
                },
              },
              classContents: {
                select: {
                  id: true,
                  title: true,
                  description: true,
                  order: true,
                  hoursAllotted: true,
                },
                orderBy: {
                  order: "asc",
                },
              },
            },
          },
          appointments: {
            select: {
              id: true,
              slotsOfAppointment: {
                select: {
                  id: true,
                  slotStartTimeInUTC: true,
                  slotEndTimeInUTC: true,
                  isTentative: true,
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
          waitlist: {
            select: {
              id: true,
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
        orderBy: {
          createdAt: "desc",
        },
      }),
    ]);

    // Calculate participant counts from appointments and waitlist
    const participantCounts: Record<string, number> = {};

    // Count webinar participants
    webinars.forEach((webinar) => {
      const appointmentUsers =
        webinar.appointment?.slotsOfAppointment?.[0]?.user.length || 0;
      const waitlistUsers = webinar.waitlist?.length || 0;
      participantCounts[webinar.id] = appointmentUsers + waitlistUsers;
    });

    // Count class participants
    classes.forEach((classEvent) => {
      const appointmentUsers = classEvent.appointments.reduce((sum, apt) => {
        return sum + (apt.slotsOfAppointment?.[0]?.user.length || 0);
      }, 0);
      const waitlistUsers = classEvent.waitlist?.length || 0;
      participantCounts[classEvent.id] = appointmentUsers + waitlistUsers;
    });

    // Transform to include type discriminator
    const webinarsWithType = webinars.map((webinar) => ({
      ...webinar,
      type: "webinar" as const,
    }));

    const classesWithType = classes.map((classEvent) => ({
      ...classEvent,
      type: "class" as const,
    }));

    const plannerData = {
      webinars: webinarsWithType,
      classes: classesWithType,
      participantCounts,
    };

    return NextResponse.json({
      data: plannerData,
      success: true,
    });
  } catch (error) {
    console.error("Error fetching planner data:", error);
    return NextResponse.json(
      { error: "Failed to fetch planner data" },
      { status: 500 },
    );
  }
}
